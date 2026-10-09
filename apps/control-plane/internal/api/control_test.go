package api

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
)

func TestMessageProvisionsRuntime(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	c.tick()
	id, generation := c.liveInstance(c.agent.ID)
	expect(t, generation, int64(1))
	expect(t, scalar[string](c.env, "SELECT status FROM runtime_instance WHERE id = $1", id), "provisioning")
	env := c.driver.started[0].Env
	expect(t, env["AXP_RUNTIME_TOKEN"], auth.RuntimeToken(c.secret, id, 1))
	expect(t, env["AXP_GATEWAY_URL"], "http://runtime-gateway:8090")
	// It reads the agent's queue.
	expect(t, fmt.Sprint(c.nats.Consumers), fmt.Sprint([]string{c.agent.ID}))
	expect(t, env["AXP_NATS_URL"], "nats://nats:4222")
	// A new agent has nothing to restore.
	if _, ok := env["AXP_SNAPSHOT_URL"]; ok {
		t.Fatal("a snapshot to restore")
	}
	// The reply waits while the agent starts.
	expect(t, c.replyStatus(sent), "queued")
	expect(t, c.agentStatus(), "starting")
	c.runtime(c.agent.ID).ready("thread-1")
	expect(t, c.agentStatus(), "working")
	// No second runtime while one is live.
	c.tick()
	expect(t, len(c.driver.started), 1)
}

func TestQueueDownRefusesTheMessage(t *testing.T) {
	c := newControl(t)
	c.nats.Down = true
	expectError(t, c.post("/chat/messages", map[string]any{"agent_id": c.agent.ID, "text": "你好"}), 503, "QUEUE_UNAVAILABLE")
	expect(t, scalar[int](c.env, "SELECT count(*) FROM message"), 0)
}

func TestStartFailureFailsWaitingReplies(t *testing.T) {
	c := newControl(t)
	c.driver.failStart = true
	sent := c.sendText("检查项目结构")
	c.tick()
	expect(t, c.replyStatus(sent), "failed")
	expect(t, c.replyFailure(sent), "AGENT_UNAVAILABLE")
	expect(t, c.agentStatus(), "unavailable")
}

func TestRuntimeThatNeverComesUpFailsWhatWaits(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	c.tick() // provisions; never becomes ready
	c.expireLeases()
	c.tick()
	expect(t, c.replyFailure(sent), "START_TIMEOUT")
	// Its queue is emptied: nothing runs later.
	expect(t, len(c.nats.Queued(c.agent.ID)), 0)
}

func TestRuntimeThatOnlyReportsStartingTimesOut(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	c.tick()
	r := c.runtime(c.agent.ID)
	expect(t, r.heartbeat("starting").status, 200)
	c.tick()
	expect(t, c.replyStatus(sent), "queued")
	// Still "starting" past the start timeout: its heartbeats no longer
	// extend the lease.
	c.exec("UPDATE runtime_instance SET created_at = created_at - $1::interval", "121 seconds")
	expect(t, r.heartbeat("starting").status, 200)
	c.tick()
	expect(t, c.replyFailure(sent), "START_TIMEOUT")
	// It never came up: the next one waits RetryAfter instead of crash-looping.
	c.sendText("再试一次")
	c.tick()
	expect(t, len(c.driver.started), 1)
}

func TestRuntimeThatCameUpIsNotTimedOutWhenItFails(t *testing.T) {
	c, r := provisioned(t)
	r.ready("thread-1")
	c.exec("UPDATE runtime_instance SET created_at = created_at - $1::interval", "1 hour")
	expect(t, r.heartbeat("busy").status, 200)
	c.tick()
	_, generation := c.liveInstance(c.agent.ID)
	expect(t, generation, int64(1))
	// It came up once, so a crash is retried at once, not backed off.
	c.expireLeases()
	c.tick()
	c.sendText("继续")
	c.tick()
	_, generation = c.liveInstance(c.agent.ID)
	expect(t, generation, int64(2))
}

func provisioned(t *testing.T) (*controlEnv, *runtimeHarness) {
	c := newControl(t)
	c.sendText("检查项目结构")
	c.tick()
	return c, c.runtime(c.agent.ID)
}

func TestPublicServerDoesNotRouteInternalAPI(t *testing.T) {
	c, r := provisioned(t)
	resp := do(t, c.public, http.MethodPost, "/internal/v1/runtime-instances/"+r.instanceID+"/heartbeat", nil, nil)
	expect(t, resp.status, 404)
}

func TestTokenIsBoundToInstanceAndGeneration(t *testing.T) {
	c, r := provisioned(t)
	expect(t, r.heartbeat("ready").status, 200)
	expect(t, r.call(http.MethodPost, "heartbeat", map[string]any{"status": "ready"}, "x").status, 403)
	c.exec("UPDATE agent SET generation = 2 WHERE id = $1", c.agent.ID)
	expectError(t, r.heartbeat("ready"), 409, "STALE_GENERATION")
}

func runtimeAuth(c *controlEnv, key string) response {
	return do(c.t, c.internal, http.MethodGet, "/internal/v1/runtime-auth", nil, map[string]string{"Authorization": "Bearer " + key})
}

func TestRuntimeAuthNamesTheAgent(t *testing.T) {
	c, r := provisioned(t)
	key := r.instanceID + "." + r.token
	resp := runtimeAuth(c, key)
	expect(t, resp.status, 204)
	expect(t, resp.header.Get("X-AXP-Agent-Id"), c.agent.ID)
	for _, bad := range []string{r.instanceID + ".x", r.token, ""} {
		expect(t, runtimeAuth(c, bad).status, 403)
	}
	c.exec("UPDATE agent SET generation = 2 WHERE id = $1", c.agent.ID)
	expectError(t, runtimeAuth(c, key), 409, "STALE_GENERATION")
}

func TestSessionThreadCannotChange(t *testing.T) {
	c, r := provisioned(t)
	expect(t, r.session("t1").status, 200)
	expect(t, r.session("t1").status, 200)
	expect(t, r.session("t2").status, 409)
	expect(t, scalar[string](c.env, "SELECT thread_id FROM agent_session"), "t1")
}

func TestHeartbeatMarksReadyAndExtendsLease(t *testing.T) {
	c, r := provisioned(t)
	before := scalar[time.Time](c.env, "SELECT lease_expires_at FROM runtime_instance")
	r.ready("thread-1")
	expect(t, scalar[string](c.env, "SELECT status FROM runtime_instance"), "ready")
	if scalar[time.Time](c.env, "SELECT lease_expires_at FROM runtime_instance").Equal(before) {
		t.Fatal("lease not extended")
	}
	expect(t, scalar[string](c.env, "SELECT status FROM agent"), "ready")
}

func TestEventOrdering(t *testing.T) {
	c, r := provisioned(t)
	r.ready("thread-1")
	failed := event{"snapshot.failed", map[string]any{"reason": "SNAPSHOT_FAILED"}}
	expect(t, r.events(failed).m(t)["acked_source_seq"], any(float64(1)))
	gap := r.eventsFrom(5, event{"snapshot.saved", map[string]any{}})
	expect(t, gap.status, 409)
	expect(t, gap.m(t)["next_expected_source_seq"], any(float64(2)))
	// Re-sending an acked event is harmless; changing it is a conflict.
	r.seq = 0
	expect(t, r.events(failed).m(t)["acked_source_seq"], any(float64(1)))
	r.seq = 0
	conflict := r.events(event{"snapshot.failed", map[string]any{"reason": "OTHER"}})
	expect(t, conflict.status, 409)
	expect(t, scalar[string](c.env, "SELECT last_error FROM agent_session"), "SNAPSHOT_FAILED")
}

func TestEventsWithNULAreImported(t *testing.T) {
	c, r := provisioned(t)
	r.ready("thread-1")
	item := map[string]any{"id": "cmd-1", "kind": "command", "status": "completed",
		"input": "find . -print0", "output": "a\x00b\x00"}
	resp := r.events(event{"item.updated", map[string]any{"item": item, "note\x00": "x\x00y"}})
	expect(t, resp.status, 200)
	expect(t, scalar[string](c.env, "SELECT payload->'item'->>'output' FROM agent_event"), "ab")
	expect(t, scalar[string](c.env, "SELECT payload->>'note' FROM agent_event"), "xy")
	// Re-sent as it was, it is the same event.
	r.seq = 0
	expect(t, r.events(event{"item.updated", map[string]any{"item": item, "note\x00": "x\x00y"}}).status, 200)
}

func TestEventBatchesUpTo4MiBAreTaken(t *testing.T) {
	c, r := provisioned(t)
	r.ready("thread-1")
	// 1.5 MiB as sent: the runtime's batches are up to 1 MiB, with margin.
	text := strings.Repeat("长", 1<<19)
	expect(t, r.events(event{"snapshot.failed", map[string]any{"reason": "SNAPSHOT_FAILED", "text": text}}).status, 200)
	huge := strings.Repeat("长", 2<<20)
	expect(t, r.events(event{"snapshot.failed", map[string]any{"reason": "SNAPSHOT_FAILED", "text": huge}}).status, 413)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM agent_event"), 1)
}

func TestQueueStreamAndComplete(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	command := c.commandOf(sent)
	// Waiting is a message in the agent's queue, nothing else.
	want := []map[string]any{{
		"command_id": command, "kind": "turn", "agent_sequence": float64(1),
		"payload": map[string]any{"text": "检查项目结构"},
	}}
	if got := c.nats.Queued(c.agent.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("queued %v", got)
	}
	expect(t, scalar[int64](c.env, "SELECT queue_seq FROM agent_command"), 1)
	r := c.startRuntime("thread-1")
	c.take(command)
	r.turnStarted(command, "turn-1")
	expect(t, c.commandStatus(command), "running")
	instance, _ := c.liveInstance(c.agent.ID)
	expect(t, scalar[string](c.env, "SELECT runtime_instance_id FROM agent_command"), instance)
	r.events(
		item(command, "id", "c1", "kind", "command", "status", "running", "input", "ls"),
		item(command, "id", "m1", "kind", "agent_message", "status", "running", "text", "正在"),
	)
	expect(t, c.replyStatus(sent), "responding")
	var blocks []chat.Block
	readBlocks := func() {
		var msg chat.Message
		page := chat.MessagePage{}
		c.get("/agents/"+c.agent.ID+"/messages").json(t, &page)
		for _, m := range page.Items {
			if m.ID == sent.Reply.ID {
				msg = m
			}
		}
		blocks = msg.Blocks
	}
	readBlocks()
	expect(t, blocks[0].Input, "ls")
	expect(t, blocks[0].Label, "运行命令")
	expect(t, blocks[1].Text, "正在")
	r.events(
		item(command, "id", "m1", "kind", "agent_message", "status", "completed", "text", "正在检查。"),
		event{"turn.completed", map[string]any{"command_id": command, "turn_id": "turn-1", "status": "completed"}},
	)
	expect(t, c.replyStatus(sent), "completed")
	readBlocks()
	expect(t, blocks[0].Status, "completed")
	expect(t, blocks[1].Text, "正在检查。")
	expect(t, c.commandStatus(command), "succeeded")
	expect(t, scalar[string](c.env, "SELECT codex_turn_id FROM agent_command"), "turn-1")
	var snapshot chat.Snapshot
	resp := c.get("/chat")
	resp.json(t, &snapshot)
	expect(t, snapshot.Agents[0].Status, "idle")
	assertNoInternalFields(t, resp.m(t))
}

func TestCommandsQueueInOrder(t *testing.T) {
	c := newControl(t)
	first := c.commandOf(c.sendText("第一条"))
	second := c.commandOf(c.sendText("第二条"))
	queued := c.nats.Queued(c.agent.ID)
	expect(t, queued[0]["command_id"], any(first))
	expect(t, queued[1]["command_id"], any(second))
}

func TestFailedTurnHasProductReason(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnCompleted(command, "failed")
	expect(t, c.replyStatus(sent), "failed")
	expect(t, scalar[string](c.env, "SELECT failure::text FROM message WHERE id = $1", sent.Reply.ID),
		`{"code": "TURN_FAILED", "message": "智能体执行失败，请稍后再试。"}`)
}

func TestOutcomeUnknownIsNotReplayed(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.events(event{"command.outcome_unknown", map[string]any{"command_id": command}})
	expect(t, c.replyFailure(sent), "REPLY_INTERRUPTED")
}

func TestStopSendsInterruptAndRuntimeConfirms(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	stop := c.post("/chat/messages/"+sent.Reply.ID+"/stop", nil)
	expect(t, stop.m(t)["status"], any("stopping"))
	expect(t, fmt.Sprint(c.nats.ToldOf("interrupt")), fmt.Sprint([]map[string]any{{"command_id": command}}))
	// Stopping again asks again.
	c.post("/chat/messages/"+sent.Reply.ID+"/stop", nil)
	expect(t, len(c.nats.ToldOf("interrupt")), 2)
	r.turnCompleted(command, "interrupted")
	expect(t, c.replyStatus(sent), "stopped")
}

func TestStopWhileQueuedTakesItOffTheQueue(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	c.post("/chat/messages/"+sent.Reply.ID+"/stop", nil)
	expect(t, c.replyStatus(sent), "stopped")
	expect(t, c.commandStatus(c.commandOf(sent)), "cancelled")
	expect(t, len(c.nats.Queued(c.agent.ID)), 0)
	expect(t, len(c.nats.Told), 0)
}

func (c *controlEnv) interactions() []chat.Interaction {
	var snapshot chat.Snapshot
	c.get("/chat").json(c.t, &snapshot)
	return snapshot.Interactions
}

func TestApprovalRoundTrip(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	r.events(event{"approval.requested", map[string]any{
		"approval_id": "sdk-1", "command_id": command, "kind": "command",
		"summary": map[string]any{"command": "rm -rf build", "reason": "清理构建产物"},
	}})
	var snapshot chat.Snapshot
	c.get("/chat").json(t, &snapshot)
	expect(t, len(snapshot.Interactions), 1)
	interaction := snapshot.Interactions[0]
	if !strings.Contains(interaction.Prompt, "rm -rf build") {
		t.Fatalf("prompt %q", interaction.Prompt)
	}
	expect(t, snapshot.Agents[0].Status, "waiting_for_input")
	assertNoInternalFields(t, interaction)
	answer := c.post("/chat/interactions/"+interaction.ID+"/answer", map[string]any{"value": "allow"})
	expect(t, answer.m(t)["status"], any("submitted"))
	expect(t, scalar[string](c.env, "SELECT status FROM approval"), "decided")
	decision := fmt.Sprint([]map[string]any{{"approval_id": "sdk-1", "decision": "accept"}})
	expect(t, fmt.Sprint(c.nats.ToldOf("decision")), decision)
	// Answering the same again resends it until the runtime applies it.
	c.post("/chat/interactions/"+interaction.ID+"/answer", map[string]any{"value": "allow"})
	expect(t, len(c.nats.ToldOf("decision")), 2)
	r.events(event{"approval.applied", map[string]any{"approval_id": "sdk-1", "decision": "accept"}})
	expect(t, scalar[string](c.env, "SELECT status FROM interaction"), "resolved")
	expect(t, scalar[string](c.env, "SELECT status FROM approval"), "applied")
	expect(t, c.replyStatus(sent), "responding")
	// Answered, it leaves the snapshot but stays in the list, with its answer.
	expect(t, len(c.interactions()), 0)
	var list chat.InteractionList
	c.get("/chat/interactions").json(t, &list)
	expect(t, len(list.Interactions), 1)
	expect(t, list.Interactions[0].Status, "resolved")
	expect(t, *list.Interactions[0].Answer, "allow")
	assertNoInternalFields(t, list.Interactions[0])
}

func TestPluginConfirmation(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	r.events(event{"approval.requested", map[string]any{
		"approval_id": "sdk-1", "command_id": command, "kind": "elicitation",
		"summary": map[string]any{"server": "tasks", "message": "清空所有任务？"},
	}})
	interaction := c.interactions()[0]
	expect(t, interaction.Prompt, "tasks 请求确认\n清空所有任务？")
	expect(t, interaction.AgentID, c.agent.ID)
	expect(t, scalar[string](c.env, "SELECT kind FROM approval"), "elicitation")
	c.post("/chat/interactions/"+interaction.ID+"/answer", map[string]any{"value": "deny"})
	told := c.nats.ToldOf("decision")
	expect(t, told[len(told)-1]["decision"], any("decline"))
}

func (c *controlEnv) steer(text string) chat.Sent {
	c.t.Helper()
	r := c.post("/chat/messages", map[string]any{"agent_id": c.agent.ID, "text": text, "mode": "steer"})
	if r.status != 202 {
		c.t.Fatalf("steer: %d %s", r.status, r.body)
	}
	var sent chat.Sent
	r.json(c.t, &sent)
	return sent
}

func TestCompactRunsAsItsOwnCommand(t *testing.T) {
	c := newControl(t)
	r := c.post("/agents/"+c.agent.ID+"/compact", nil)
	expect(t, r.status, 202)
	var sent chat.Sent
	r.json(t, &sent)
	expect(t, sent.Message.Blocks[0].Text, "/compact")
	assertNoInternalFields(t, sent)
	runtime := c.startRuntime("thread-1")
	command := c.commandOf(sent)
	expect(t, c.take(command)["kind"], any("compact"))
	runtime.turnStarted(command, "t")
	runtime.events(item(command, "id", "k1", "kind", "compaction"))
	runtime.turnCompleted(command, "completed")
	expect(t, c.replyStatus(sent), "completed")
	expect(t, scalar[string](c.env, "SELECT content->0->>'label' FROM message WHERE id = $1", sent.Reply.ID), "压缩上下文")
}

func TestSteerJoinsTheRunningTurn(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	c.nats.Steering = true
	steered := c.steer("改用中文")
	expect(t, steered.Steered, true)
	steer := c.commandOf(steered)
	// Handed straight to the running turn, never queued.
	want := []map[string]any{{"type": "steer", "command_id": steer, "agent_sequence": float64(2), "text": "改用中文"}}
	if !reflect.DeepEqual(c.nats.Asked, want) {
		t.Fatalf("asked %v", c.nats.Asked)
	}
	expect(t, len(c.nats.Queued(c.agent.ID)), 0)
	expect(t, c.commandStatus(steer), "queued")
	expect(t, scalar[*int64](c.env, "SELECT queue_seq FROM agent_command WHERE id = $1", steer) == nil, true)
	r.events(
		event{"turn.steered", map[string]any{"command_id": command, "steer_command_id": steer, "turn_id": "t"}},
		item(steer, "id", "m2", "kind", "agent_message", "text", "好的"),
	)
	expect(t, c.replyStatus(sent), "completed")
	expect(t, c.commandStatus(steer), "running")
	expect(t, scalar[string](c.env, "SELECT codex_turn_id FROM agent_command WHERE id = $1", steer), "t")
	expect(t, c.replyStatus(steered), "responding")
	expect(t, c.agentStatus(), "working")
	r.turnCompleted(steer, "completed")
	expect(t, scalar[string](c.env, "SELECT content->0->>'text' FROM message WHERE id = $1", steered.Reply.ID), "好的")
	expect(t, c.agentStatus(), "idle")
}

func TestSteerTheTurnRefusesWaitsItsTurn(t *testing.T) {
	c := newControl(t)
	c.running()
	steered := c.steer("改用中文")
	expect(t, steered.Steered, false)
	steer := c.commandOf(steered)
	// With no turn to join, it is queued like any turn.
	expect(t, c.nats.Queued(c.agent.ID)[0]["command_id"], any(steer))
}

func TestStoppingASteerInTheTurnInterruptsIt(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	c.nats.Steering = true
	steered := c.steer("改用中文")
	steer := c.commandOf(steered)
	stop := c.post("/chat/messages/"+steered.Reply.ID+"/stop", nil)
	expect(t, stop.m(t)["status"], any("stopping"))
	expect(t, fmt.Sprint(c.nats.ToldOf("interrupt")), fmt.Sprint([]map[string]any{{"command_id": steer}}))
	r.events(event{"turn.steered", map[string]any{"command_id": command, "steer_command_id": steer, "turn_id": "t"}})
	r.turnCompleted(steer, "interrupted")
	expect(t, c.replyStatus(steered), "stopped")
}

func TestLostRuntimeIsFencedThenReplaced(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	c.s3.snapshots[c.agent.ID] = true
	old, _ := c.liveInstance(c.agent.ID)
	container := scalar[string](c.env, "SELECT container_id FROM runtime_instance WHERE id = $1", old)
	c.expireLeases()
	c.tick()
	if !c.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	expect(t, scalar[bool](c.env, "SELECT ended_at IS NOT NULL FROM runtime_instance WHERE id = $1", old), true)
	// Its work went with the container and is never replayed.
	expect(t, c.commandStatus(command), "failed")
	expect(t, c.replyFailure(sent), "REPLY_INTERRUPTED")
	c.sendText("继续")
	c.tick()
	// The replacement restores the snapshot and resumes the same thread.
	_, generation := c.liveInstance(c.agent.ID)
	expect(t, generation, int64(2))
	env := c.driver.started[len(c.driver.started)-1].Env
	expect(t, env["AXP_THREAD_ID"], "thread-1")
	expect(t, env["AXP_SNAPSHOT_URL"], "http://s3.test/get/"+c.agent.ID)
	// The old runtime is rejected from now on.
	expect(t, r.heartbeat("ready").status, 409)
}

func TestTakenCommandIsNeverReplayed(t *testing.T) {
	c := newControl(t)
	// Taken from the queue, but no event about it arrived.
	sent, _, command := c.running()
	c.expireLeases()
	c.tick()
	expect(t, c.commandStatus(command), "failed")
	expect(t, c.replyFailure(sent), "REPLY_INTERRUPTED")
}

func TestWaitingCommandGoesToTheNextRuntime(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("检查项目结构")
	c.startRuntime("thread-1")
	c.expireLeases()
	c.tick()
	// Still in the queue: the next runtime takes it.
	expect(t, c.replyStatus(sent), "queued")
	_, generation := c.liveInstance(c.agent.ID)
	expect(t, generation, int64(2))
	c.take(c.commandOf(sent))
}

func TestRuntimeFailureMarksAgentUnavailable(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	queued := c.sendText("排队中")
	r.heartbeat("error", "error_code", "PLUGIN_INSTALL_FAILED")
	expect(t, c.replyFailure(queued), "AGENT_EXTENSION_FAILED")
	expect(t, len(c.nats.Queued(c.agent.ID)), 0)
	expect(t, c.agentStatus(), "unavailable")
	// A new message retries with a fresh runtime.
	c.sendText("再试一次")
	c.tick()
	_, generation := c.liveInstance(c.agent.ID)
	expect(t, generation, int64(2))
}

func TestRecoveryFailedNeverReplacesThread(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	r.heartbeat("recovery_failed", "error_code", "RECOVERY_RESUME_FAILED")
	expect(t, scalar[string](c.env, "SELECT status FROM agent"), "recovery_failed")
	expect(t, scalar[string](c.env, "SELECT status FROM agent_session"), "recovery_failed")
	expect(t, scalar[string](c.env, "SELECT thread_id FROM agent_session"), "thread-1")
}

func TestRuntimeGetsAnUploadURLForItsOwnAgentOnly(t *testing.T) {
	c := newControl(t)
	_, r, _ := c.running()
	resp := r.call(http.MethodPost, "snapshot", nil)
	expect(t, resp.m(t)["upload_url"], any("http://s3.test/put/"+c.agent.ID))
	// A fenced instance gets nothing.
	c.expireLeases()
	c.tick()
	expect(t, r.call(http.MethodPost, "snapshot", nil).status, 409)
}

func TestFailedSnapshotIsRecordedUntilOneSucceeds(t *testing.T) {
	c := newControl(t)
	_, r, _ := c.running()
	r.events(event{"snapshot.failed", map[string]any{"reason": "SNAPSHOT_TOO_LARGE"}})
	expect(t, scalar[string](c.env, "SELECT last_error FROM agent_session"), "SNAPSHOT_TOO_LARGE")
	r.events(event{"snapshot.saved", map[string]any{"size": 1}})
	expect(t, scalar[*string](c.env, "SELECT last_error FROM agent_session") == nil, true)
}

func TestIdleRuntimeIsStopped(t *testing.T) {
	c := newControl(t)
	c.controller.IdleAfter = time.Nanosecond
	_, r, command := c.running()
	r.turnCompleted(command, "completed")
	c.exec("UPDATE agent SET last_active_at = $1", time.Now().Add(-5*time.Second))
	instance, _ := c.liveInstance(c.agent.ID)
	container := scalar[string](c.env, "SELECT container_id FROM runtime_instance WHERE id = $1", instance)
	if err := c.controller.LookAtQueue(c.ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.controller.StopIdle(c.ctx); err != nil {
		t.Fatal(err)
	}
	if !c.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	expect(t, scalar[int](c.env, "SELECT count(*) FROM runtime_instance WHERE ended_at IS NULL"), 0)
	expect(t, c.agentStatus(), "idle")
}

func TestDeletedAgentIsInterruptedThenStopped(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	r.turnStarted(command, "t")
	instance, _ := c.liveInstance(c.agent.ID)
	container := scalar[string](c.env, "SELECT container_id FROM runtime_instance WHERE id = $1", instance)
	expect(t, c.delete("/agents/"+c.agent.ID).status, 204)
	c.tick()
	// Still running: interrupted first, not killed mid-turn.
	expect(t, fmt.Sprint(c.nats.ToldOf("interrupt")), fmt.Sprint([]map[string]any{{"command_id": command}}))
	if c.driver.wasStopped(container) {
		t.Fatal("stopped mid-turn")
	}
	r.turnCompleted(command, "interrupted")
	c.tick()
	if !c.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	// Its queue goes with it.
	expect(t, fmt.Sprint(c.nats.Forgotten), fmt.Sprint([]string{c.agent.ID}))
	expect(t, scalar[int](c.env, "SELECT count(*) FROM runtime_instance WHERE ended_at IS NULL"), 0)
	// Nothing restarts it.
	c.tick()
	expect(t, len(c.driver.started), 1)
}

func TestRestartInterruptsTheTurnThenReplacesTheRuntime(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnStarted(command, "t")
	old, _ := c.liveInstance(c.agent.ID)
	container := scalar[string](c.env, "SELECT container_id FROM runtime_instance WHERE id = $1", old)
	expect(t, c.post("/agents/"+c.agent.ID+"/restart", nil).status, 204)
	c.tick()
	// Interrupted first, so the turn's snapshot is uploaded before the stop.
	expect(t, fmt.Sprint(c.nats.ToldOf("interrupt")), fmt.Sprint([]map[string]any{{"command_id": command}}))
	if c.driver.wasStopped(container) {
		t.Fatal("stopped mid-turn")
	}
	r.turnCompleted(command, "interrupted")
	c.tick()
	if !c.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	expect(t, scalar[string](c.env, "SELECT end_reason FROM runtime_instance WHERE id = $1", old), "CONFIG_CHANGED")
	expect(t, c.replyStatus(sent), "stopped")
	// The next message starts a new runtime on the same thread.
	c.sendText("重启之后")
	c.tick()
	expect(t, len(c.driver.started), 2)
	expect(t, c.driver.started[1].Env["AXP_THREAD_ID"], "thread-1")
}

func TestRuntimeGetsTheAgentsPlugins(t *testing.T) {
	c := newControl(t)
	c.patch("/agents/"+c.agent.ID, map[string]any{"plugins": []string{"memory"}})
	c.sendText("检查项目结构")
	c.startRuntime("thread-1")
	expect(t, fmt.Sprint(c.settings(c.driver.started[0])["plugins"]), "[memory]")
}

func TestInstructionsArePassedAndAppliedBetweenTurns(t *testing.T) {
	c := newControl(t)
	path := "/agents/" + c.agent.ID
	instructions := func(i int) any { return c.settings(c.driver.started[i])["developer_instructions"] }
	c.patch(path, map[string]any{"description": "第一版指令"})
	sent := c.sendText("检查项目结构")
	r := c.startRuntime("thread-1")
	expect(t, instructions(0), any("你的名字是开发助手。\n\n第一版指令"))
	command := c.commandOf(sent)
	c.take(command)
	r.turnStarted(command, "t")
	old, _ := c.liveInstance(c.agent.ID)
	container := scalar[string](c.env, "SELECT container_id FROM runtime_instance WHERE id = $1", old)

	c.patch(path, map[string]any{"name": "审查员", "description": "第二版指令"})
	c.tick()
	// A turn is running: the runtime keeps going until it settles.
	if c.driver.wasStopped(container) {
		t.Fatal("stopped mid-turn")
	}
	r.turnCompleted(command, "completed")
	c.tick()
	if !c.driver.wasStopped(container) {
		t.Fatal("not stopped")
	}
	expect(t, scalar[string](c.env, "SELECT end_reason FROM runtime_instance WHERE id = $1", old), "CONFIG_CHANGED")
	// The next message starts a runtime with the new instructions.
	c.sendText("新指令下")
	c.tick()
	last := len(c.driver.started) - 1
	expect(t, instructions(last), any("你的名字是审查员。\n\n第二版指令"))
	expect(t, c.driver.started[last].Env["AXP_THREAD_ID"], "thread-1")
}

func TestRuntimeReachesModelsAndStorageWithoutCredentials(t *testing.T) {
	c := newControl(t)
	c.sendText("检查项目结构")
	t.Setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=production")
	t.Setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20secret")
	c.startRuntime("thread-1")
	env := c.driver.started[0].Env
	for k := range env {
		if strings.HasPrefix(k, "AXP_S3") {
			t.Fatalf("storage credentials: %s", k)
		}
	}
	expect(t, env["OTEL_EXPORTER_OTLP_ENDPOINT"], "http://otel-collector:4318")
	instance, _ := c.liveInstance(c.agent.ID)
	expect(t, env["OTEL_RESOURCE_ATTRIBUTES"], "deployment.environment.name=production,"+
		"axp.agent.id="+c.agent.ID+",axp.runtime.instance.id="+instance+",axp.runtime.generation=1")
	if _, ok := env["OTEL_EXPORTER_OTLP_HEADERS"]; ok {
		t.Fatal("collector credentials")
	}
}
