package api

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/akarachen/axp/apps/control-plane/internal/auth"
	"github.com/akarachen/axp/apps/control-plane/internal/chat"
	"github.com/google/uuid"
)

// --- containers ----------------------------------------------------------------------

func TestAgentGetsItsImageAndContainer(t *testing.T) {
	c := newControl(t)
	c.settle()
	builds := c.driver.builds()
	expect(t, len(builds), 1)
	runs := c.driver.runsOf(c.agent.ID)
	expect(t, len(runs), 1)
	spec := runs[0]
	expect(t, spec.Image, builds[0])
	key := spec.Env["AXP_AGENT_KEY"]
	expect(t, key, auth.AgentKey(c.secret, c.agent.ID))
	// The model provider is the LLM gateway, through the runtime gateway,
	// with the agent's key.
	expect(t, spec.Env["AXP_LLM_BASE_URL"], "http://runtime-gateway:8090/v1")
	expect(t, spec.Env["AXP_LLM_API_KEY"], key)
	expect(t, spec.Env["AXP_MODEL"], testModel)
	expect(t, spec.Env["AXP_MODEL_CONTEXT_WINDOW"], "200000")
	expect(t, spec.Env["AXP_INSTRUCTIONS"], "你的名字是开发助手。")
	expect(t, spec.Env["AXP_CONTROL_TOKEN"], auth.ControlToken(c.secret, c.agent.ID))
	// Every built-in bundle's plugin is compiled into it.
	dockerfile := c.driver.contexts[0]
	if !strings.Contains(dockerfile, "FROM axp-agent-runtime:test") || !strings.Contains(dockerfile, "COPY bundles/memory ") ||
		!strings.Contains(dockerfile, "axp-plugins chat") {
		t.Fatalf("Dockerfile:\n%s", dockerfile)
	}
	// Nothing changes: nothing happens.
	c.tick()
	expect(t, len(c.driver.runsOf(c.agent.ID)), 1)
	expect(t, len(c.driver.builds()), 1)
}

func TestAgentsWithTheSameBundlesShareAnImage(t *testing.T) {
	c := newControl(t)
	c.createAgent("第二个")
	c.settle()
	expect(t, len(c.driver.builds()), 1)
}

func TestWorkWaitsForTheRuntimeToReportItself(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("你好")
	c.settle()
	expect(t, c.agentStatus(), "starting")
	expect(t, len(c.prompted()), 0)
	c.boot()
	expect(t, c.prompted()[0], c.commandOf(sent))
	body := c.runtimes.called("/prompt")[0]
	expect(t, strings.HasSuffix(body["text"].(string), "\n你好"), true)
	expect(t, body["boot_id"], any(scalar[string](c.env, "SELECT boot_id::text FROM agent WHERE id = $1", c.agent.ID)))
}

func TestATurnStreamsAndCompletes(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	expect(t, c.replyStatus(sent), "responding")
	expect(t, c.agentStatus(), "working")
	r.events(
		item(command, "id", "x1", "kind", "command", "status", "completed", "input", "ls", "output", "a\nb"),
		item(command, "id", "m1", "kind", "agent_message", "text", "完成。"),
	)
	r.turnCompleted(command, "completed")
	expect(t, c.replyStatus(sent), "completed")
	expect(t, c.commandStatus(command), "succeeded")
	expect(t, c.agentStatus(), "idle")
	blocks := scalar[string](c.env, "SELECT content::text FROM message WHERE id = $1", sent.Replies[0].ID)
	if !strings.Contains(blocks, "运行命令") || !strings.Contains(blocks, "完成。") {
		t.Fatalf("blocks: %s", blocks)
	}
}

func TestCommandsRunOneAtATimeInOrder(t *testing.T) {
	c := newControl(t)
	first := c.sendText("一")
	second := c.sendText("二")
	r := c.boot()
	expect(t, len(c.prompted()), 1)
	r.turnStarted(c.commandOf(first), "turn-1")
	c.tick()
	expect(t, len(c.prompted()), 1)
	r.turnCompleted(c.commandOf(first), "completed")
	expect(t, slices.Equal(c.prompted(), []string{c.commandOf(first), c.commandOf(second)}), true)
}

func TestFailedTurnHasProductReason(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.turnCompleted(command, "failed")
	expect(t, c.replyStatus(sent), "failed")
	expect(t, c.replyFailure(sent), "TURN_FAILED")
}

func TestPromptMeantForAnotherBootWaits(t *testing.T) {
	c := newControl(t)
	c.runtimes.answering(func(string) (int, map[string]any) {
		return http.StatusConflict, map[string]any{"accepted": false, "code": "wrong_boot"}
	})
	sent := c.sendText("你好")
	c.boot()
	expect(t, len(c.prompted()), 1)
	expect(t, c.commandStatus(c.commandOf(sent)), "queued")
	expect(t, scalar[bool](c.env, "SELECT delivered_at IS NULL FROM agent_command WHERE id = $1", c.commandOf(sent)), true)
	c.runtimes.answering(nil)
	c.tick()
	expect(t, len(c.prompted()), 2)
	expect(t, c.commandStatus(c.commandOf(sent)), "running")
}

func TestUnreachableRuntimeKeepsTheCommand(t *testing.T) {
	c := newControl(t)
	c.driver.down = true
	sent := c.sendText("你好")
	c.boot()
	expect(t, c.commandStatus(c.commandOf(sent)), "queued")
	c.driver.down = false
	c.tick()
	expect(t, c.prompted()[0], c.commandOf(sent))
}

func TestRefusedPromptFails(t *testing.T) {
	c := newControl(t)
	c.runtimes.answering(func(string) (int, map[string]any) {
		return http.StatusConflict, map[string]any{"accepted": false, "code": "runtime_refused", "reason": "no"}
	})
	sent := c.sendText("你好")
	c.boot()
	expect(t, c.replyStatus(sent), "failed")
	expect(t, c.replyFailure(sent), "TURN_FAILED")
}

func TestANewBootFailsWhatTheOldOneHad(t *testing.T) {
	c := newControl(t)
	sent, _, command := c.running()
	waiting := c.sendText("还在等")
	// Docker restarted the runtime: the new boot reports itself.
	r := &runtimeHarness{e: c.env, agentID: c.agent.ID, boot: uuid.NewString()}
	r.events(event{"runtime.started", map[string]any{"thread_id": "thread-1", "resumed": true}})
	expect(t, c.commandStatus(command), "failed")
	expect(t, c.replyFailure(sent), "REPLY_INTERRUPTED")
	// What waited is the new boot's.
	expect(t, c.prompted()[1], c.commandOf(waiting))
}

func TestRedeliveredEventsAreImportedOnce(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.events(item(command, "id", "m1", "kind", "agent_message", "text", "一"))
	revision := scalar[int64](c.env, "SELECT revision FROM message WHERE id = $1", sent.Replies[0].ID)
	r.resend(chat.RuntimeEvent{BootID: r.boot, Seq: r.seq, Type: "item.updated", Payload: map[string]any{
		"command_id": command, "item": map[string]any{"id": "m1", "kind": "agent_message", "text": "一"},
	}})
	expect(t, scalar[int64](c.env, "SELECT revision FROM message WHERE id = $1", sent.Replies[0].ID), revision)
	expect(t, scalar[int](c.env, "SELECT count(*) FROM agent_event WHERE type = 'item.updated'"), 1)
}

func TestEventsWithNULAreImported(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.events(item(command, "id", "x1", "kind", "command", "status", "completed", "input", "find . -print0", "output", "a\x00b"))
	content := scalar[string](c.env, "SELECT content::text FROM message WHERE id = $1", sent.Replies[0].ID)
	if !strings.Contains(content, `"output": "ab"`) {
		t.Fatalf("content: %s", content)
	}
}

// --- stops ---------------------------------------------------------------------------

func TestStopQueuedReplyCancelsIt(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("你好")
	r := c.post("/chat/messages/"+sent.Replies[0].ID+"/stop", nil)
	expect(t, r.status, 200)
	expect(t, c.replyStatus(sent), "stopped")
	c.boot()
	expect(t, len(c.prompted()), 0)
}

func TestStopAsksTheRuntimeAndItConfirms(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	expect(t, c.post("/chat/messages/"+sent.Replies[0].ID+"/stop", nil).status, 200)
	expect(t, c.replyStatus(sent), "stopping")
	c.controller.Dispatch(c.ctx, c.agent.ID)
	aborts := c.runtimes.called("/abort")
	expect(t, len(aborts), 1)
	expect(t, aborts[0]["command_id"], any(command))
	// Asked again only after a while.
	c.controller.Dispatch(c.ctx, c.agent.ID)
	expect(t, len(c.runtimes.called("/abort")), 1)
	r.turnCompleted(command, "interrupted")
	expect(t, c.replyStatus(sent), "stopped")
	expect(t, c.commandStatus(command), "interrupted")
}

// --- steers --------------------------------------------------------------------------

func steer(c *controlEnv, text string) chat.Sent {
	c.t.Helper()
	r := c.post("/chat/messages", map[string]any{"group_id": c.direct(c.agent.ID), "text": text, "mode": "steer"})
	expect(c.t, r.status, 202)
	var sent chat.Sent
	r.json(c.t, &sent)
	c.wake()
	return sent
}

func TestSteerJoinsTheRunningTurn(t *testing.T) {
	c := newControl(t)
	first, r, command := c.running()
	sent := steer(c, "也看看测试")
	steers := c.runtimes.called("/steer")
	expect(t, len(steers), 1)
	steerCommand := c.commandOf(sent)
	expect(t, steers[0]["command_id"], any(steerCommand))
	expect(t, strings.HasSuffix(steers[0]["text"].(string), "\n也看看测试"), true)
	expect(t, c.commandStatus(steerCommand), "queued")
	r.events(event{"turn.steered", map[string]any{"command_id": command, "steer_command_id": steerCommand, "turn_id": "turn-1"}})
	expect(t, c.replyStatus(first), "completed")
	expect(t, c.commandStatus(steerCommand), "running")
	expect(t, c.replyStatus(sent), "responding")
	r.turnCompleted(steerCommand, "completed")
	expect(t, c.replyStatus(sent), "completed")
	// It never ran as a turn of its own.
	expect(t, len(c.prompted()), 1)
}

func TestSteerTheTurnRefusesWaitsItsTurn(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	c.runtimes.answering(func(path string) (int, map[string]any) {
		if path == "/steer" {
			return http.StatusConflict, map[string]any{"accepted": false, "code": "no_active_turn"}
		}
		return 200, map[string]any{"accepted": true}
	})
	sent := steer(c, "也看看测试")
	expect(t, len(c.runtimes.called("/steer")), 1)
	c.tick()
	expect(t, len(c.runtimes.called("/steer")), 1)
	r.turnCompleted(command, "completed")
	expect(t, c.prompted()[1], c.commandOf(sent))
}

func TestSteerWithNoRunningTurnIsATurn(t *testing.T) {
	c := newControl(t)
	c.boot()
	sent := steer(c, "你好")
	expect(t, len(c.runtimes.called("/steer")), 0)
	expect(t, c.prompted()[0], c.commandOf(sent))
}

func TestStoppingADeliveredSteerAsksTheRuntime(t *testing.T) {
	c := newControl(t)
	_, _, _ = c.running()
	sent := steer(c, "也看看测试")
	expect(t, c.post("/chat/messages/"+sent.Replies[0].ID+"/stop", nil).status, 200)
	expect(t, c.replyStatus(sent), "stopping")
	c.controller.Dispatch(c.ctx, c.agent.ID)
	aborts := c.runtimes.called("/abort")
	expect(t, aborts[len(aborts)-1]["command_id"], any(c.commandOf(sent)))
}

// --- configuration -------------------------------------------------------------------

func TestConfigChangeReplacesTheContainerBetweenTurns(t *testing.T) {
	c := newControl(t)
	_, r, command := c.running()
	expect(t, c.patch("/agents/"+c.agent.ID, map[string]any{"description": "只用中文回答。"}).status, 200)
	c.tick()
	expect(t, len(c.driver.runsOf(c.agent.ID)), 1)
	// Nothing new starts on the old configuration.
	waiting := c.sendText("下一个")
	r.turnCompleted(command, "completed")
	expect(t, len(c.prompted()), 1)
	c.tick()
	runs := c.driver.runsOf(c.agent.ID)
	expect(t, len(runs), 2)
	expect(t, runs[1].Env["AXP_INSTRUCTIONS"], "你的名字是开发助手。\n\n只用中文回答。")
	expect(t, c.agentStatus(), "starting")
	c.boot()
	expect(t, c.prompted()[1], c.commandOf(waiting))
}

func TestRestartReplacesTheContainer(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	expect(t, c.post("/agents/"+c.agent.ID+"/restart", nil).status, 204)
	expect(t, c.replyStatus(sent), "stopping")
	r.turnCompleted(command, "interrupted")
	c.tick()
	expect(t, len(c.driver.runsOf(c.agent.ID)), 2)
}

func TestChangingBundlesBuildsAnotherImage(t *testing.T) {
	c := newControl(t)
	c.settle()
	expect(t, c.patch("/agents/"+c.agent.ID, map[string]any{"bundles": []string{"grok"}}).status, 200)
	c.settle()
	for range 200 {
		if len(c.driver.runsOf(c.agent.ID)) == 2 {
			break
		}
		c.tick()
	}
	builds := c.driver.builds()
	expect(t, len(builds), 2)
	runs := c.driver.runsOf(c.agent.ID)
	expect(t, len(runs), 2)
	expect(t, runs[1].Image, builds[1])
	if !strings.Contains(c.driver.contexts[1], "bundles/memory") {
		t.Fatalf("Dockerfile:\n%s", c.driver.contexts[1])
	}
}

func TestFailedBuildMakesTheAgentUnavailable(t *testing.T) {
	c := newControl(t)
	c.driver.failBuilds = "E: Unable to locate package nope"
	sent := c.sendText("你好")
	for range 200 {
		c.tick()
		if c.agentStatus() == "unavailable" {
			break
		}
	}
	expect(t, c.agentStatus(), "unavailable")
	expect(t, c.replyFailure(sent), "AGENT_BUILD_FAILED")
	var snapshot chat.Snapshot
	c.get("/chat").json(t, &snapshot)
	if snapshot.Agents[0].BuildError == nil || !strings.Contains(*snapshot.Agents[0].BuildError, "nope") {
		t.Fatalf("build error: %v", snapshot.Agents[0].BuildError)
	}
	// Later messages fail at once; nothing builds again by itself.
	later := c.sendText("再试")
	c.controller.Dispatch(c.ctx, c.agent.ID)
	expect(t, c.replyFailure(later), "AGENT_BUILD_FAILED")
	builds := len(c.driver.builds())
	c.tick()
	expect(t, len(c.driver.builds()), builds)
	// A restart builds again.
	c.driver.failBuilds = ""
	expect(t, c.post("/agents/"+c.agent.ID+"/restart", nil).status, 204)
	c.settle()
	expect(t, len(c.driver.builds()), builds+1)
	expect(t, c.agentStatus(), "idle")
}

func TestRuntimeFailureFailsWhatWaits(t *testing.T) {
	c := newControl(t)
	sent := c.sendText("你好")
	c.settle()
	r := &runtimeHarness{e: c.env, agentID: c.agent.ID, boot: uuid.NewString()}
	r.events(event{"runtime.failed", map[string]any{"code": "PLUGIN_INSTALL_FAILED"}})
	expect(t, c.agentStatus(), "unavailable")
	expect(t, c.replyFailure(sent), "AGENT_EXTENSION_FAILED")
	// The next boot (Docker starts it again) makes it available.
	c.boot()
	expect(t, c.agentStatus(), "idle")
}

func TestDeletedAgentsContainerIsRemoved(t *testing.T) {
	c := newControl(t)
	sent, _, command := c.running()
	expect(t, c.delete("/agents/"+c.agent.ID).status, 204)
	c.tick()
	expect(t, slices.Contains(c.driver.removed, c.agent.ID), true)
	expect(t, c.commandStatus(command), "cancelled")
	expect(t, c.replyStatus(sent), "stopped")
}

// --- the runtime gateway -------------------------------------------------------------

func TestPublicServerDoesNotRouteInternalAPI(t *testing.T) {
	e := newEnv(t)
	r := do(t, e.public, http.MethodGet, "/internal/v1/runtime-auth", nil, nil)
	expect(t, r.status, 404)
}

func runtimeAuth(e *env, key, plugin string) response {
	path := "/internal/v1/runtime-auth"
	if plugin != "" {
		path += "?plugin=" + plugin
	}
	return do(e.t, e.internal, http.MethodGet, path, nil, map[string]string{"Authorization": "Bearer " + key})
}

func TestRuntimeAuthNamesTheAgent(t *testing.T) {
	c := newControl(t)
	key := auth.AgentKey(c.secret, c.agent.ID)
	r := runtimeAuth(c.env, key, "")
	expect(t, r.status, 204)
	expect(t, r.header.Get("X-AXP-Agent-Id"), c.agent.ID)
	expectError(t, runtimeAuth(c.env, key+"x", ""), 403, "INVALID_AGENT_KEY")
	expectError(t, runtimeAuth(c.env, "nope", ""), 403, "INVALID_AGENT_KEY")
	expectError(t, runtimeAuth(c.env, auth.AgentKey([]byte("other"), c.agent.ID), ""), 403, "INVALID_AGENT_KEY")
	// A deleted agent's key no longer works.
	expect(t, c.delete("/agents/"+c.agent.ID).status, 204)
	expectError(t, runtimeAuth(c.env, key, ""), 403, "INVALID_AGENT_KEY")
}

func TestRuntimeAuthChecksTheRoutesPlugin(t *testing.T) {
	c := newControl(t)
	key := auth.AgentKey(c.secret, c.agent.ID)
	expect(t, runtimeAuth(c.env, key, "memory").status, 204)
	expect(t, c.patch("/agents/"+c.agent.ID, map[string]any{"bundles": []string{"grok"}}).status, 200)
	expect(t, runtimeAuth(c.env, key, "memory").status, 204)
	expect(t, runtimeAuth(c.env, key, "groups").status, 204)
	expectError(t, runtimeAuth(c.env, key, "tasks"), 403, "PLUGIN_NOT_ENABLED")
	expect(t, runtimeAuth(c.env, key, "grok").status, 204)
}

// --- approvals and compaction ------------------------------------------------

func (c *controlEnv) interactions() []chat.Interaction {
	var snapshot chat.Snapshot
	c.get("/chat").json(c.t, &snapshot)
	return snapshot.Interactions
}

func TestApprovalRoundTrip(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
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
	expect(t, c.replyStatus(sent), "waiting_for_input")
	expect(t, c.commandStatus(command), "waiting_approval")
	assertNoInternalFields(t, interaction)
	answer := c.post("/chat/interactions/"+interaction.ID+"/answer", map[string]any{"value": "allow"})
	expect(t, answer.m(t)["status"], any("submitted"))
	expect(t, scalar[string](c.env, "SELECT status FROM approval"), "decided")
	c.wake()
	decided := c.runtimes.called("/decide")
	expect(t, len(decided), 1)
	expect(t, fmt.Sprint(decided[0]), fmt.Sprint(map[string]any{"approval_id": "sdk-1", "decision": "accept"}))
	// Until the runtime applies it, it is handed over again now and then.
	c.wake()
	expect(t, len(c.runtimes.called("/decide")), 1)
	r.events(event{"approval.applied", map[string]any{"approval_id": "sdk-1", "decision": "accept"}})
	expect(t, scalar[string](c.env, "SELECT status FROM interaction"), "resolved")
	expect(t, scalar[string](c.env, "SELECT status FROM approval"), "applied")
	expect(t, c.replyStatus(sent), "responding")
	expect(t, c.commandStatus(command), "running")
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
	r.events(event{"approval.requested", map[string]any{
		"approval_id": "sdk-1", "command_id": command, "kind": "elicitation",
		"summary": map[string]any{"server": "tasks", "message": "清空所有任务？"},
	}})
	interaction := c.interactions()[0]
	expect(t, interaction.Prompt, "tasks 请求确认\n清空所有任务？")
	expect(t, scalar[string](c.env, "SELECT kind FROM approval"), "elicitation")
	c.post("/chat/interactions/"+interaction.ID+"/answer", map[string]any{"value": "deny"})
	c.wake()
	decided := c.runtimes.called("/decide")
	expect(t, decided[len(decided)-1]["decision"], any("decline"))
}

func TestStoppingWhileWaitingForApprovalExpiresIt(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.events(event{"approval.requested", map[string]any{
		"approval_id": "sdk-1", "command_id": command, "kind": "command", "summary": map[string]any{"command": "ls"},
	}})
	expect(t, c.post("/chat/messages/"+sent.Replies[0].ID+"/stop", nil).status, 200)
	expect(t, c.replyStatus(sent), "stopping")
	expect(t, scalar[string](c.env, "SELECT status FROM interaction"), "expired")
	c.wake()
	aborts := c.runtimes.called("/abort")
	expect(t, aborts[len(aborts)-1]["command_id"], any(command))
	r.events(event{"approval.applied", map[string]any{"approval_id": "sdk-1", "decision": "cancel"}})
	r.turnCompleted(command, "interrupted")
	expect(t, c.replyStatus(sent), "stopped")
}

func TestApprovalsOfAGoneBootExpire(t *testing.T) {
	c := newControl(t)
	sent, r, command := c.running()
	r.events(event{"approval.requested", map[string]any{
		"approval_id": "sdk-1", "command_id": command, "kind": "command", "summary": map[string]any{"command": "ls"},
	}})
	next := &runtimeHarness{e: c.env, agentID: c.agent.ID, boot: uuid.NewString()}
	next.events(event{"runtime.started", map[string]any{"thread_id": "thread-1", "resumed": true}})
	expect(t, c.replyFailure(sent), "REPLY_INTERRUPTED")
	expect(t, scalar[string](c.env, "SELECT status FROM approval"), "expired")
	expect(t, scalar[string](c.env, "SELECT status FROM interaction"), "expired")
}

func TestCompactRunsAsItsOwnCommand(t *testing.T) {
	c := newControl(t)
	r := c.post("/groups/"+c.direct(c.agent.ID)+"/compact", map[string]any{})
	expect(t, r.status, 202)
	var sent chat.Sent
	r.json(t, &sent)
	expect(t, sent.Message.Blocks[0].Text, "/compact")
	assertNoInternalFields(t, sent)
	runtime := c.boot()
	command := c.commandOf(sent)
	prompt := c.runtimes.called("/prompt")[0]
	expect(t, prompt["command_id"], any(command))
	expect(t, prompt["kind"], any("compact"))
	runtime.turnStarted(command, "t")
	runtime.events(item(command, "id", "k1", "kind", "compaction"))
	runtime.turnCompleted(command, "completed")
	expect(t, c.replyStatus(sent), "completed")
	expect(t, scalar[string](c.env, "SELECT content->0->>'label' FROM message WHERE id = $1", sent.Replies[0].ID), "压缩上下文")
}

func TestRuntimeAuthForBundlesServices(t *testing.T) {
	c := newControl(t)
	ask := func(key, query string, headers map[string]string) response {
		if headers == nil {
			headers = map[string]string{}
		}
		headers["Authorization"] = "Bearer " + key
		return do(c.env.t, c.env.internal, http.MethodGet, "/internal/v1/runtime-auth"+query, nil, headers)
	}
	agent := auth.AgentKey(c.secret, c.agent.ID)
	// An agent reaches the services of the bundles it loads.
	expect(t, ask(agent, "?bundle=memory", nil).status, 204)
	expectError(t, ask(agent, "?bundle=nope", nil), 403, "BUNDLE_NOT_LOADED")

	// The memory's service uses the models, for the agent it names.
	memory := auth.BundleToken(c.secret, "memory")
	r := ask(memory, "?use=llm", map[string]string{"X-AXP-Agent-Id": c.agent.ID})
	expect(t, r.status, 204)
	expect(t, r.header.Get("X-AXP-Agent-Id"), c.agent.ID)
	expect(t, r.header.Get("X-AXP-Bundle"), "memory")
	// Nothing else: not another agent's service, plugin routes or
	// credentials, and as itself.
	r = ask(memory, "?bundle=agenvo", map[string]string{"X-AXP-Agent-Id": c.agent.ID})
	expectError(t, r, 403, "BUNDLE_NOT_ALLOWED")
	expectError(t, ask(memory, "?plugin=tasks", nil), 403, "BUNDLE_NOT_ALLOWED")
	expectError(t, ask(memory, "", nil), 403, "BUNDLE_NOT_ALLOWED")
	// agenvo's service declares no uses; forged tokens are nobody's.
	expectError(t, ask(auth.BundleToken(c.secret, "agenvo"), "?use=llm", nil), 403, "BUNDLE_NOT_ALLOWED")
	expectError(t, ask(auth.BundleToken([]byte("other"), "memory"), "?use=llm", nil), 403, "INVALID_AGENT_KEY")
}
