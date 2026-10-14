package api

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/akarachen/axp/apps/control-plane/internal/tasks"
	"github.com/akarachen/axp/packages/service-go/pg"
	"github.com/jackc/pgx/v5"
)

func TestGroupContextWithoutMentionsAndOrderedTargets(t *testing.T) {
	e := newEnv(t)
	a := e.createAgent("Aria")
	b := e.createAgent("Bolt")
	var g chat.Group
	r := e.post("/groups", map[string]any{"name": "讨论", "members": []string{a.ID, b.ID}})
	expect(t, r.status, 201)
	r.json(t, &g)
	var sent chat.Sent
	r = e.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "仅作背景"})
	expect(t, r.status, 202)
	r.json(t, &sent)
	expect(t, len(sent.Replies), 0)
	expect(t, scalar[int](e, "SELECT count(*) FROM agent_command"), 0)
	r = e.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "一起看看", "mentions": []string{b.ID, a.ID}}, "two-targets")
	expect(t, r.status, 202)
	r.json(t, &sent)
	expect(t, len(sent.Replies), 2)
	expect(t, sent.Replies[0].AgentID, b.ID)
	expect(t, sent.Replies[1].AgentID, a.ID)
	expect(t, sent.Replies[0].Seq < sent.Replies[1].Seq, true)
	r = e.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "一起看看", "mentions": []string{b.ID, a.ID}}, "two-targets")
	expect(t, r.status, 202)
	expect(t, scalar[int](e, "SELECT count(*) FROM agent_command"), 2)
	expect(t, e.get("/agents/"+a.ID+"/messages").status, 404)
}

func TestMentionStopsAtFiveAndPromptsToInviteGuest(t *testing.T) {
	c := newControl(t)
	b := c.createAgent("Bolt")
	first, _, command := c.running()
	groupID := first.Message.GroupID
	root := first.Message.ID
	sender := c.agent.ID
	target := b.ID
	call := func(from, to string) *chat.MentionResult {
		t.Helper()
		result, err := pg.InTxValue(context.Background(), c.db, func(tx pgx.Tx) (*chat.MentionResult, error) {
			return c.chat.Mention(c.ctx, tx, groupID, from, to, "请补充依据")
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	for i := 0; i < 5; i++ {
		result := call(sender, target)
		expect(t, result.Sent, true)
		expect(t, result.Remaining, 4-i)
		c.exec("UPDATE agent_command SET status='succeeded' WHERE id=$1", command)
		command = scalar[string](c.env, `SELECT id::text FROM agent_command WHERE root_message_id=$1 AND agent_id=$2 ORDER BY agent_sequence DESC LIMIT 1`, root, target)
		c.exec("UPDATE agent_command SET status='running' WHERE id=$1", command)
		sender, target = target, sender
	}
	expect(t, call(sender, target).Sent, false)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM agent_command WHERE root_message_id=$1", root), 6)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message WHERE group_id=$1 AND data ? 'mention_limit'", groupID), 1)
	expect(t, scalar[bool](c.env, "SELECT member FROM group_participant WHERE group_id=$1 AND agent_id=$2", groupID, b.ID), false)
	if scalar[int](c.env, "SELECT count(*) FROM message WHERE group_id=$1 AND data->>'invite_agent_id'=$2", groupID, b.ID) == 0 {
		t.Fatal("guest has no invitation prompt")
	}
	expect(t, scalar[int](c.env, "SELECT count(*) FROM chat_group WHERE kind='direct'"), 2)
}

func TestStopGroupStopsItsChainAndLeavesOtherGroupsAlone(t *testing.T) {
	c := newControl(t)
	b := c.createAgent("Bolt")
	first, _, _ := c.running()
	_, err := pg.InTxValue(c.ctx, c.db, func(tx pgx.Tx) (*chat.MentionResult, error) {
		return c.chat.Mention(c.ctx, tx, first.Message.GroupID, c.agent.ID, b.ID, "请检查")
	})
	if err != nil {
		t.Fatal(err)
	}
	var other chat.Group
	c.post("/groups", map[string]any{"name": "另一群", "members": []string{c.agent.ID}}).json(t, &other)
	var waiting chat.Sent
	c.post("/chat/messages", map[string]any{"group_id": other.ID, "text": "排队"}).json(t, &waiting)
	expect(t, c.post("/groups/"+first.Message.GroupID+"/stop", nil).status, 204)
	_, err = pg.InTxValue(c.ctx, c.db, func(tx pgx.Tx) (*chat.MentionResult, error) {
		return c.chat.Mention(c.ctx, tx, first.Message.GroupID, c.agent.ID, b.ID, "继续")
	})
	if err == nil {
		t.Fatal("mention accepted after stop")
	}
	expect(t, scalar[string](c.env, "SELECT status FROM agent_command WHERE agent_id=$1", b.ID), "cancelled")
	if _, err := chat.CurrentCommand(c.ctx, c.db, first.Message.GroupID, b.ID); err == nil {
		t.Fatal("cancelled recipient still has a current command")
	}
	expect(t, scalar[string](c.env, "SELECT status FROM message WHERE id=$1", waiting.Replies[0].ID), "queued")
}

func TestControllerPersistsEachGroupsThreadAndOnlySteersWithinGroup(t *testing.T) {
	c := newControl(t)
	first, r, command := c.running()
	r.events(event{"thread.opened", map[string]any{"command_id": command, "thread_key": first.Message.GroupID, "codex_thread_id": "direct-thread"}})
	expect(t, scalar[string](c.env, "SELECT codex_thread_id FROM group_participant WHERE group_id=$1 AND agent_id=$2", first.Message.GroupID, c.agent.ID), "direct-thread")
	var g chat.Group
	c.post("/groups", map[string]any{"name": "另一个主题", "members": []string{c.agent.ID}}).json(t, &g)
	var sent chat.Sent
	c.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "新问题", "mode": "steer"}).json(t, &sent)
	c.wake()
	expect(t, len(c.runtimes.called("/steer")), 0)
	expect(t, len(c.prompted()), 1)
	expect(t, runtimeAuth(c.env, auth.AgentKey(c.secret, c.agent.ID), "groups").header.Get("X-AXP-Group-Id"), first.Message.GroupID)
	r.turnCompleted(command, "completed")
	prompt := c.runtimes.called("/prompt")[1]
	expect(t, prompt["thread_key"], any(g.ID))
	expect(t, prompt["codex_thread_id"], any(nil))
	otherCommand := c.commandOf(sent)
	r.events(event{"thread.opened", map[string]any{"command_id": otherCommand, "thread_key": g.ID, "codex_thread_id": "topic-thread"}})
	expect(t, runtimeAuth(c.env, auth.AgentKey(c.secret, c.agent.ID), "groups").header.Get("X-AXP-Group-Id"), g.ID)
	r.turnStarted(otherCommand, "other-turn")
	r.turnCompleted(otherCommand, "completed")
	c.sendText("回到私聊")
	prompt = c.runtimes.called("/prompt")[2]
	expect(t, prompt["thread_key"], any(first.Message.GroupID))
	expect(t, prompt["codex_thread_id"], any("direct-thread"))
}

func TestTaskDraftConfirmationUpdatesOneCardWithSourceSnapshot(t *testing.T) {
	c := newControl(t)
	sent, _, _ := c.running()
	g := sent.Message.GroupID
	draft, err := pg.InTxValue(c.ctx, c.db, func(tx pgx.Tx) (*chat.Message, error) {
		return c.chat.DraftTask(c.ctx, tx, g, c.agent.ID, chat.DraftTaskInput{Title: "测试草稿", Goal: "确定范围", Decided: "松绑定", Acceptance: "可以验收"})
	})
	if err != nil {
		t.Fatal(err)
	}
	expect(t, scalar[int](c.env, "SELECT count(*) FROM task"), 0)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM task_run"), 0)
	description := draft.Data["description"].(string)
	expect(t, strings.Contains(description, fmt.Sprintf("来源：群《%s》第 %d–%d 条", c.agent.Name, sent.Message.Seq, sent.Replies[0].Seq)), true)
	body := map[string]any{"title": "用户编辑后的任务", "description": description, "assignee": map[string]any{"kind": "none"}}
	path := "/groups/" + g + "/drafts/" + draft.ID + "/confirm"
	r := c.post(path, body)
	expect(t, r.status, 201)
	var task tasks.TaskDetail
	r.json(t, &task)
	expect(t, *task.GroupID, g)
	expect(t, task.Description, description)
	expect(t, task.Title, "用户编辑后的任务")
	expect(t, scalar[int](c.env, "SELECT count(*) FROM task_run"), 0)
	expect(t, c.post(path, body).status, 201)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM task"), 1)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message WHERE kind='task_card'"), 1)
	expect(t, scalar[string](c.env, "SELECT data->>'task_id' FROM message WHERE id=$1", draft.ID), task.ID)
	expect(t, c.patch("/tasks/"+task.ID, map[string]any{"status": "done"}).status, 200)
	expect(t, scalar[string](c.env, "SELECT data->>'status' FROM message WHERE id=$1", draft.ID), "done")
	expect(t, c.post("/tasks/"+task.ID+"/comments", map[string]any{"body": "结果已验收"}).status, 201)
	expect(t, scalar[string](c.env, "SELECT data->>'summary' FROM message WHERE id=$1", draft.ID), "结果已验收")
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message WHERE kind='task_card'"), 1)
	commentBody := map[string]any{"body": "请核对验收条件", "group_id": g}
	expect(t, c.post("/tasks/"+task.ID+"/comments", commentBody, "group-reply").status, 201)
	expect(t, c.post("/tasks/"+task.ID+"/comments", commentBody, "group-reply").status, 201)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message WHERE kind='system' AND data->>'task_id'=$1", task.ID), 1)
	expect(t, scalar[string](c.env, "SELECT data->>'comments' FROM message WHERE id=$1", draft.ID), "2")
	expect(t, c.patch("/tasks/"+task.ID, map[string]any{"group_id": ""}).status, 200)
	expect(t, scalar[bool](c.env, "SELECT group_id IS NULL FROM task WHERE id=$1", task.ID), true)
	expect(t, c.delete("/tasks/"+task.ID).status, 204)
	expect(t, scalar[bool](c.env, "SELECT (data->>'deleted')::boolean FROM message WHERE id=$1", draft.ID), true)
}

func TestMultiTargetFailureDoesNotDiscardOtherReplies(t *testing.T) {
	e := newEnv(t)
	a := e.createAgent("Aria")
	b := e.createAgent("Bolt", "")
	var g chat.Group
	e.post("/groups", map[string]any{"name": "讨论", "members": []string{a.ID, b.ID}}).json(t, &g)
	var sent chat.Sent
	r := e.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "一起看看", "mentions": []string{b.ID, a.ID}})
	expect(t, r.status, 202)
	r.json(t, &sent)
	expect(t, len(sent.Replies), 2)
	expect(t, sent.Replies[0].AgentID, b.ID)
	expect(t, sent.Replies[0].Status, "failed")
	expect(t, sent.Replies[0].Failure.Code, "MODEL_NOT_SET")
	expect(t, sent.Replies[1].Status, "queued")
	expect(t, scalar[int](e, "SELECT count(*) FROM agent_command"), 1)
}

func TestAgentEditsRefreshGroupParticipants(t *testing.T) {
	e := newEnv(t)
	a := e.createAgent("Aria")
	b := e.createAgent("Bolt")
	var g chat.Group
	e.post("/groups", map[string]any{"name": "讨论", "members": []string{a.ID, b.ID}}).json(t, &g)
	before := scalar[int](e, "SELECT count(*) FROM ui_event WHERE type='group.updated'")
	expect(t, e.patch("/agents/"+b.ID, map[string]any{"name": "新名字"}).status, 200)
	expect(t, scalar[int](e, "SELECT count(*) FROM ui_event WHERE type='group.updated'")-before, 2)
	e.get("/groups/"+g.ID).json(t, &g)
	expect(t, g.Participants[1].Name, "新名字")
	expect(t, e.delete("/agents/"+b.ID).status, 204)
	e.get("/groups/"+g.ID).json(t, &g)
	expect(t, len(g.Participants), 1)
	expect(t, g.Participants[0].AgentID, a.ID)
}

func TestConcurrentMentionBranchesShareMessageBudget(t *testing.T) {
	c := newControl(t)
	b := c.createAgent("Bolt")
	first, _, _ := c.running()
	call := func(from, to string) (*chat.MentionResult, error) {
		return pg.InTxValue(c.ctx, c.db, func(tx pgx.Tx) (*chat.MentionResult, error) {
			return c.chat.Mention(c.ctx, tx, first.Message.GroupID, from, to, "请补充依据")
		})
	}
	for i := 0; i < 4; i++ {
		result, err := call(c.agent.ID, b.ID)
		if err != nil {
			t.Fatal(err)
		}
		expect(t, result.Sent, true)
	}
	c.exec(`UPDATE agent_command SET status='running' WHERE id=(SELECT id FROM agent_command WHERE agent_id=$1 ORDER BY agent_sequence LIMIT 1)`, b.ID)
	type answer struct {
		result *chat.MentionResult
		err    error
	}
	answers := make(chan answer, 2)
	for _, pair := range [][2]string{{c.agent.ID, b.ID}, {b.ID, c.agent.ID}} {
		go func(from, to string) { r, err := call(from, to); answers <- answer{r, err} }(pair[0], pair[1])
	}
	accepted := 0
	for range 2 {
		a := <-answers
		if a.err != nil {
			t.Fatal(a.err)
		}
		if a.result.Sent {
			accepted++
		}
	}
	expect(t, accepted, 1)
	expect(t, scalar[int](c.env, `SELECT count(*) FROM message WHERE kind='mention' AND reply_to_id=$1`, first.Message.ID), 5)
	expect(t, scalar[int](c.env, `SELECT count(*) FROM message WHERE data ? 'mention_limit'`), 1)
}

func TestGroupSearchMatchesAllChineseTermsAndLiteralWildcards(t *testing.T) {
	c := newControl(t)
	first, _, _ := c.running()
	g := first.Message.GroupID
	for _, text := range []string{"群讨论决定使用松绑定", "群讨论还未决定", "占比100% 字段a_b"} {
		expect(t, c.post("/chat/messages", map[string]any{"group_id": g, "text": text}).status, 202)
	}
	for _, tc := range []struct {
		query string
		count int
	}{{"讨论 松绑定", 1}, {"松绑定\t讨论", 1}, {"讨论 验收", 0}, {"100% a_b", 1}, {"100_", 0}} {
		rows, err := c.chat.GroupMessages(c.ctx, c.db, g, c.agent.ID, 0, 0, 30, tc.query)
		if err != nil {
			t.Fatal(err)
		}
		expect(t, len(rows), tc.count)
	}
}

func TestGroupListUsesLastMessageTimeAndKindControlsAuthor(t *testing.T) {
	e := newEnv(t)
	a := e.createAgent("Aria")
	var g chat.Group
	e.get("/groups/"+e.direct(a.ID)).json(t, &g)
	expect(t, g.LastMessageAt == nil, true)
	var sent chat.Sent
	e.post("/chat/messages", map[string]any{"group_id": g.ID, "text": "你好"}).json(t, &sent)
	expect(t, e.patch("/groups/"+g.ID, map[string]any{"archived": true}).status, 200)
	e.get("/groups/"+g.ID).json(t, &g)
	expect(t, g.LastMessageAt.Equal(sent.Replies[0].CreatedAt.Time), true)
	_, err := e.db.Exec(e.ctx, `UPDATE message SET agent_id=$2 WHERE id=$1`, sent.Message.ID, a.ID)
	if err == nil {
		t.Fatal("user message accepted an agent author")
	}
	_, err = e.db.Exec(e.ctx, `UPDATE message SET kind='system' WHERE id=$1`, sent.Replies[0].ID)
	if err == nil {
		t.Fatal("system notice accepted an agent author")
	}
}

func TestGroupInfoListsOnlyLinkedTasks(t *testing.T) {
	c := newControl(t)
	first, _, _ := c.running()
	b := c.createAgent("Bolt")
	for _, group := range []string{first.Message.GroupID, c.direct(b.ID)} {
		expect(t, c.post("/tasks", map[string]any{"title": "群任务", "group_id": group, "assignee": map[string]any{"kind": "none"}}).status, 201)
	}
	r := do(t, c.internal, http.MethodPost, "/groups/mcp", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "group_info", "arguments": map[string]any{}},
	}, map[string]string{"X-AXP-Agent-Id": c.agent.ID, "X-AXP-Group-Id": first.Message.GroupID, "Accept": "application/json, text/event-stream"})
	expect(t, r.status, 200)
	var result struct {
		Result struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				Tasks []tasks.Task `json:"tasks"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	r.json(t, &result)
	expect(t, result.Result.IsError, false)
	expect(t, len(result.Result.StructuredContent.Tasks), 1)
	expect(t, *result.Result.StructuredContent.Tasks[0].GroupID, first.Message.GroupID)
}
