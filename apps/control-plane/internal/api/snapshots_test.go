package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/chat"
)

// turn runs one turn to its end as the runtime does: it takes the command,
// reports the turn finished, then uploads the snapshot after it.
func (c *controlEnv) turn(r *runtimeHarness, text string) string {
	c.t.Helper()
	sent := c.sendText(text)
	command := c.commandOf(sent)
	c.take(command)
	r.turnStarted(command, "t-"+command)
	r.turnCompletedUploading(command, "completed")
	if resp := r.call(http.MethodPost, "snapshot", map[string]any{"command_id": command}); resp.status != 200 {
		c.t.Fatalf("snapshot: %d %s", resp.status, resp.body)
	}
	r.events(event{"snapshot.saved", map[string]any{"size": 1}})
	return command
}

func (c *controlEnv) snapshots() []chat.AgentSnapshot {
	c.t.Helper()
	var list SnapshotList
	c.get("/agents/"+c.agent.ID+"/snapshots").json(c.t, &list)
	return list.Snapshots
}

// Going back to the snapshot after an earlier turn: the agent's next runtime
// starts from it, and a runtime from before cannot save over it.
func TestGoingBackToAnEarlierSnapshot(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	r.turnCompleted(command, "completed")
	c.turn(r, "第一处改动")
	c.turn(r, "第二处改动")
	list := c.snapshots()
	if len(list) != 2 || !list[0].Current || *list[0].Message != "第二处改动" || *list[1].Message != "第一处改动" {
		t.Fatalf("%+v", list)
	}
	before := scalar[int64](c.env, "SELECT config_version FROM agent")

	// While a reply waits or works, so does going back.
	waiting := c.sendText("第三处改动")
	expectError(t, c.post("/agents/"+c.agent.ID+"/snapshots/"+list[1].ID+"/restore", nil), 409, "AGENT_BUSY")
	if r := c.post("/chat/messages/"+waiting.Reply.ID+"/stop", nil); r.status != 200 {
		t.Fatalf("stop: %d %s", r.status, r.body)
	}

	resp := c.post("/agents/"+c.agent.ID+"/snapshots/"+list[1].ID+"/restore", nil)
	if resp.status != 200 {
		t.Fatalf("restore: %d %s", resp.status, resp.body)
	}
	var restored SnapshotList
	resp.json(t, &restored)
	current := restored.Snapshots[0]
	if current.Kind != "restore" || *current.RestoredFrom != list[1].ID || !current.Current {
		t.Fatalf("%+v", current)
	}
	expect(t, scalar[int64](c.env, "SELECT config_version FROM agent"), before+1)
	expectError(t, c.post("/agents/"+c.agent.ID+"/snapshots/nope/restore", nil), 404, "NOT_FOUND")
	// The runtime from before the restore holds the home it undid.
	expectError(t, r.call(http.MethodPost, "snapshot", map[string]any{"command_id": command}), 409, "SNAPSHOT_SUPERSEDED")
	// It is replaced; the next one starts from the restored snapshot.
	c.tick()
	c.sendText("继续")
	c.tick()
	env := c.driver.started[len(c.driver.started)-1].Env
	expect(t, env["AXP_SNAPSHOT_URL"], "http://s3.test/get/"+current.ID)
	expect(t, env["AXP_THREAD_ID"], "thread-1")
}

// An agent that cannot recover its thread from its newest snapshot is not
// stuck: going back to an earlier one makes it available again.
func TestAnAgentThatCannotRecoverComesBackFromAnEarlierSnapshot(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	r.turnCompleted(command, "completed")
	c.turn(r, "改动")
	c.s3.add(c.agent.ID, "turn", "broken")
	r.heartbeat("recovery_failed", "error_code", "RECOVERY_RESUME_FAILED")
	expect(t, scalar[string](c.env, "SELECT status FROM agent"), "recovery_failed")
	list := c.snapshots()
	if r := c.post("/agents/"+c.agent.ID+"/snapshots/"+list[1].ID+"/restore", nil); r.status != 200 {
		t.Fatalf("restore: %d %s", r.status, r.body)
	}
	expect(t, scalar[string](c.env, "SELECT status FROM agent"), "stopped")
	expect(t, scalar[string](c.env, "SELECT status FROM agent_session"), "ready")
	if c.agentStatus() == "unavailable" {
		t.Fatal("still unavailable")
	}
}

// A copy of an agent starts from its newest snapshot and resumes its
// thread, then goes its own way; its conversation starts empty.
func TestDuplicatingAnAgent(t *testing.T) {
	c := newControl(t)
	c.patch("/agents/"+c.agent.ID, map[string]any{"plugins": []string{"memory"}, "description": "审查代码"})
	_, r, command := c.running()
	r.turnStarted(command, "t")
	r.turnCompleted(command, "completed")
	c.turn(r, "改动")
	resp := c.post("/agents/"+c.agent.ID+"/duplicate", nil)
	if resp.status != 201 {
		t.Fatalf("duplicate: %d %s", resp.status, resp.body)
	}
	var copy chat.Agent
	resp.json(t, &copy)
	if copy.Name != "开发助手 副本" || copy.Description != "审查代码" || strings.Join(copy.Plugins, ",") != "memory" ||
		*copy.Model != *c.agent.Model || copy.ID == c.agent.ID {
		t.Fatalf("%+v", copy)
	}
	copied := c.s3.snapshots[copy.ID]
	if len(copied) != 1 || copied[0].Kind != "copy" || copied[0].Ref != c.agent.ID {
		t.Fatalf("snapshots %+v", copied)
	}
	expect(t, scalar[string](c.env, "SELECT thread_id FROM agent_session WHERE agent_id = $1", copy.ID), "thread-1")
	c.send(copy.ID, "你是谁")
	c.tick()
	env := c.driver.started[len(c.driver.started)-1].Env
	expect(t, env["AXP_AGENT_ID"], copy.ID)
	expect(t, env["AXP_THREAD_ID"], "thread-1")
	expect(t, env["AXP_SNAPSHOT_URL"], "http://s3.test/get/"+copied[0].ID)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message WHERE agent_id = $1", copy.ID), 2)
}
