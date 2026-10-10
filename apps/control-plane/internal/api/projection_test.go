package api

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
)

// stream is a reply as the runtime streams it: a command starts, the text
// grows n times, the command ends.
func stream(command string, n int) []event {
	events := []event{item(command, "id", "c1", "kind", "command", "status", "running", "input", "ls")}
	text := ""
	for i := range n {
		text += fmt.Sprintf("第 %d 段。", i)
		events = append(events, item(command, "id", "m1", "kind", "agent_message", "text", text))
	}
	return append(events, item(command, "id", "c1", "kind", "command", "status", "completed",
		"input", "ls", "output", "ok"))
}

// published is the replies' states sent to browsers, in order, from the
// ui_event stream.
func (c *controlEnv) published() []chat.Message {
	c.t.Helper()
	rows, err := c.db.Query(c.ctx, `SELECT payload FROM ui_event WHERE type = 'message.updated'
		AND payload->'message'->>'role' = 'assistant' ORDER BY seq`)
	if err != nil {
		c.t.Fatal(err)
	}
	defer rows.Close()
	var out []chat.Message
	for rows.Next() {
		var update chat.MessageUpdated
		var data []byte
		if err := rows.Scan(&data); err != nil {
			c.t.Fatal(err)
		}
		if err := json.Unmarshal(data, &update); err != nil {
			c.t.Fatal(err)
		}
		out = append(out, update.Message)
	}
	return out
}

func (c *controlEnv) stored(sent chat.Sent) (content string, revision int64) {
	c.t.Helper()
	if err := c.db.QueryRow(c.ctx, "SELECT content::text, revision FROM message WHERE id = $1",
		sent.Reply.ID).Scan(&content, &revision); err != nil {
		c.t.Fatal(err)
	}
	return content, revision
}

// uiBytes is the size of the replies' message.updated ui_events.
const uiBytes = `SELECT coalesce(sum(octet_length(payload::text)), 0) FROM ui_event
	WHERE type = 'message.updated' AND payload->'message'->>'role' = 'assistant'`

// numbered is events as the boot numbered them, from seq start.
func (r *runtimeHarness) numbered(start int64, events ...event) []chat.RuntimeEvent {
	out := make([]chat.RuntimeEvent, 0, len(events))
	for i, ev := range events {
		out = append(out, chat.RuntimeEvent{BootID: r.boot, Seq: start + int64(i), Type: ev.kind, Payload: ev.payload})
	}
	return out
}

func TestStreamedUpdatesInABatchSaveTheReplyOnce(t *testing.T) {
	const n = 30
	events := func(command string) []event { return stream(command, n) }

	// One event per batch: every update is its own revision.
	c := newControl(t)
	sent, r, command := c.running()
	before := len(c.published())
	for _, ev := range events(command) {
		r.events(ev)
	}
	eachContent, eachRevision := c.stored(sent)
	eachUpdates := len(c.published())
	eachRaw := scalar[int](c.env, "SELECT count(*) FROM agent_event WHERE type = 'item.updated'")
	eachBytes := scalar[int64](c.env, uiBytes)

	// The same events in one batch.
	c = newControl(t)
	sent, r, command = c.running()
	before2 := len(c.published())
	_, startRevision := c.stored(sent)
	r.events(events(command)...)
	content, revision := c.stored(sent)
	updates := len(c.published()) - before2
	raw := scalar[int](c.env, "SELECT count(*) FROM agent_event WHERE type = 'item.updated'")
	bytes := scalar[int64](c.env, uiBytes)

	t.Logf("%d item.updated: one per batch → %d message.updated ui_events (%d bytes), revision %d; "+
		"one batch → %d (%d bytes), revision %d; agent_event rows %d and %d",
		n+2, eachUpdates-before, eachBytes, eachRevision, updates, bytes, revision, eachRaw, raw)
	expect(t, eachUpdates-before, n+2)
	expect(t, updates, 1)
	expect(t, revision, startRevision+1)
	// The same reply either way.
	expect(t, content, eachContent)
	// Every raw event is still kept, in order.
	expect(t, raw, n+2)
	expect(t, raw, eachRaw)
	expect(t, scalar[int64](c.env, "SELECT max(source_seq) FROM agent_event"), int64(n+4))
}

func TestMergedUpdatesAreSavedBeforeTheNextOtherEvent(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	before := len(c.published())
	text := func(s string) event { return item(command, "id", "m1", "kind", "agent_message", "text", s) }
	r.events(
		text("一"), text("一二"),
		// Any other event, even one nothing projects.
		event{"runtime.notice", map[string]any{}},
		text("一二三"),
		event{"turn.completed", map[string]any{"command_id": command, "status": "completed"}},
		// After the turn the reply is final: a late update changes nothing.
		text("一二三四"),
	)
	var statuses []string
	for _, m := range c.published()[before:] {
		text := ""
		if len(m.Blocks) > 0 {
			text = m.Blocks[0].Text
		}
		statuses = append(statuses, m.Status+" "+text)
	}
	want := []string{
		// 一 and 一二 as one update, saved before the other event.
		"responding 一二",
		// 一二三, saved before the turn's end.
		"responding 一二三",
		"completed 一二三",
	}
	expect(t, fmt.Sprint(statuses), fmt.Sprint(want))
	expect(t, c.replyStatus(sent), "completed")
	// Revisions only grow; the browser keeps the larger one, gaps and all.
	published := c.published()
	for i := 1; i < len(published); i++ {
		if published[i].Revision <= published[i-1].Revision {
			t.Fatalf("revision %d after %d", published[i].Revision, published[i-1].Revision)
		}
	}
}

func TestInterleavedRepliesKeepTheirOrder(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	steered := steer(c, "改用中文")
	steerCommand := c.commandOf(steered)
	before := len(c.published())
	// Two replies of the same batch, taking turns: never merged across one
	// another, so each run is saved where it ends.
	r.events(
		item(command, "id", "m1", "kind", "agent_message", "text", "甲"),
		item(command, "id", "m1", "kind", "agent_message", "text", "甲甲"),
		event{"turn.steered", map[string]any{"command_id": command, "steer_command_id": steerCommand, "turn_id": "turn-1"}},
		item(steerCommand, "id", "m2", "kind", "agent_message", "text", "乙"),
		item(steerCommand, "id", "m2", "kind", "agent_message", "text", "乙乙"),
	)
	var order []string
	for _, m := range c.published()[before:] {
		if len(m.Blocks) > 0 {
			order = append(order, m.Status+" "+m.Blocks[0].Text)
		}
	}
	expect(t, fmt.Sprint(order), fmt.Sprint([]string{"responding 甲甲", "completed 甲甲", "responding 乙乙"}))
	expect(t, scalar[string](c.env, "SELECT content->0->>'text' FROM message WHERE id = $1", sent.Reply.ID), "甲甲")
	expect(t, scalar[string](c.env, "SELECT content->0->>'text' FROM message WHERE id = $1", steered.Reply.ID), "乙乙")
}

func TestResentBatchOfMergedUpdatesChangesNothing(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	start := r.seq + 1
	batch := stream(command, 5)
	r.events(batch...)
	content, revision := c.stored(sent)
	updates := len(c.published())
	// The same batch delivered again.
	r.resend(r.numbered(start, batch...)...)
	again, againRevision := c.stored(sent)
	expect(t, again, content)
	expect(t, againRevision, revision)
	expect(t, len(c.published()), updates)
	// Part of it again, then what follows: only the new events count.
	r.resend(r.numbered(start+3, append(batch[3:], item(command, "id", "m1", "kind", "agent_message", "text", "完"))...)...)
	expect(t, len(c.published()), updates+1)
	expect(t, scalar[string](c.env, "SELECT content->1->>'text' FROM message WHERE id = $1", sent.Reply.ID), "完")
}
