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

func TestStreamedUpdatesInABatchSaveTheReplyOnce(t *testing.T) {
	const n = 30
	events := func(command string) []event { return stream(command, n) }

	// One event per batch: every update is its own revision.
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	for _, ev := range events(command) {
		expect(t, r.events(ev).status, 200)
	}
	eachContent, eachRevision := c.stored(sent)
	eachUpdates := len(c.published())
	eachRaw := scalar[int](c.env, "SELECT count(*) FROM agent_event WHERE type = 'item.updated'")
	eachBytes := scalar[int64](c.env, uiBytes)

	// The same events in one batch.
	c = newControl(t)
	sent, r, command = c.running()
	r.turnStarted(command, "t")
	before := len(c.published())
	_, startRevision := c.stored(sent)
	expect(t, r.events(events(command)...).status, 200)
	content, revision := c.stored(sent)
	updates := len(c.published()) - before
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
	expect(t, scalar[int64](c.env, "SELECT max(source_seq) FROM agent_event"), int64(n+3))
}

func TestMergedUpdatesAreSavedBeforeTheNextOtherEvent(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	before := len(c.published())
	text := func(s string) event { return item(command, "id", "m1", "kind", "agent_message", "text", s) }
	expect(t, r.events(
		text("一"), text("一二"),
		event{"approval.requested", map[string]any{
			"approval_id": "sdk-1", "command_id": command, "kind": "command",
			"summary": map[string]any{"command": "rm -rf build"},
		}},
		text("一二三"),
		event{"turn.completed", map[string]any{"command_id": command, "status": "completed"}},
		// After the turn the reply is final: a late update changes nothing.
		text("一二三四"),
	).status, 200)

	// The browser sees the reply as it was before each other event.
	var kinds []string
	rows, err := c.db.Query(c.ctx, `SELECT type, payload FROM ui_event ORDER BY seq`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var kind string
		var payload map[string]any
		if err := rows.Scan(&kind, &payload); err != nil {
			t.Fatal(err)
		}
		if kind == chat.EventMessageUpdated {
			m := payload["message"].(map[string]any)
			if m["role"] != "assistant" {
				continue
			}
			text := ""
			if blocks := m["blocks"].([]any); len(blocks) > 0 {
				text = blocks[0].(map[string]any)["text"].(string)
			}
			kind = fmt.Sprintf("%s %s %s", kind, m["status"], text)
		}
		if kind != chat.EventAgentUpdated {
			kinds = append(kinds, kind)
		}
	}
	rows.Close()
	tail := kinds[len(kinds)-6:]
	want := []string{
		// 一 and 一二 as one update, saved before the approval.
		"message.updated responding 一二",
		chat.EventInteractionUpdated,
		"message.updated waiting_for_input 一二",
		// 一二三, saved before the turn's end.
		"message.updated waiting_for_input 一二三",
		chat.EventInteractionUpdated,
		"message.updated completed 一二三",
	}
	if fmt.Sprint(tail) != fmt.Sprint(want) {
		t.Fatalf("ui events %q, want them ending %q", kinds, want)
	}
	expect(t, len(c.published())-before, 4)
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
	r.turnStarted(command, "t")
	c.nats.Steering = true
	steered := c.steer("改用中文")
	steer := c.commandOf(steered)
	before := len(c.published())
	// Two replies of the same batch, taking turns: never merged across one
	// another, so each run is saved where it ends.
	expect(t, r.events(
		item(command, "id", "m1", "kind", "agent_message", "text", "甲"),
		item(command, "id", "m1", "kind", "agent_message", "text", "甲甲"),
		item(steer, "id", "m2", "kind", "agent_message", "text", "乙"),
		item(command, "id", "m1", "kind", "agent_message", "text", "甲甲甲"),
	).status, 200)
	var order []string
	for _, m := range c.published()[before:] {
		order = append(order, m.Blocks[0].Text)
	}
	expect(t, fmt.Sprint(order), fmt.Sprint([]string{"甲甲", "乙", "甲甲甲"}))
	expect(t, scalar[string](c.env, "SELECT content->0->>'text' FROM message WHERE id = $1", sent.Reply.ID), "甲甲甲")
	expect(t, scalar[string](c.env, "SELECT content->0->>'text' FROM message WHERE id = $1", steered.Reply.ID), "乙")
}

func TestResentBatchOfMergedUpdatesChangesNothing(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	start := r.seq
	batch := stream(command, 5)
	expect(t, r.events(batch...).status, 200)
	content, revision := c.stored(sent)
	updates := len(c.published())
	// The runtime did not hear the ack and sends the batch again.
	resent := r.eventsFrom(start+1, batch...)
	expect(t, resent.status, 200)
	expect(t, resent.m(t)["acked_source_seq"], any(float64(start+int64(len(batch)))))
	again, againRevision := c.stored(sent)
	expect(t, again, content)
	expect(t, againRevision, revision)
	expect(t, len(c.published()), updates)
	// Part of it again, then what follows: only the new events count.
	expect(t, r.eventsFrom(start+4, append(batch[3:], item(command, "id", "m1", "kind", "agent_message",
		"text", "完"))...).status, 200)
	expect(t, len(c.published()), updates+1)
	expect(t, scalar[string](c.env, "SELECT content->1->>'text' FROM message WHERE id = $1", sent.Reply.ID), "完")
}
