/**
 * External runtime boundaries (`runtime !== "eta"`, covering OAR and ACP):
 * 1. No persona anywhere (creation, update, auto-clearing legacy/moved persona, Captain
 *    propose_agent / setPrompt, local + remote + daemon session defense-in-depth).
 * 2. Strict single-machine binding (`machineId !== null`, refusing null/pending/revoked, refusing
 *    machine changes while in active regular groups on other machines, refusing cross-machine
 *    groups/invites/Captain group proposals/tasks/drafts/mentions, failing cross-machine runtime
 *    replies & task runs cleanly without falling back to the project's machine, while keeping
 *    agent_home 1-on-1 chat and built-in `"eta"` behavior intact).
 */
import type { ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentView } from "@eta/client-contracts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntimeRegistry } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { fakeAgent } from "@eta/runtime-acp/testing";
import { createOarRuntimes } from "@eta/runtime-oar";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { say, scriptedModels } from "./support/models";
import { remoteWorld, sessionOf } from "./support/remote";
import { world } from "./support/world";

function oarClaude(turns: ScriptedTurn[] = []) {
  return createOarRuntimes({
    registry: createRuntimeRegistry([
      scriptedRuntime({
        id: "claude",
        turn: (turn) => {
          turns.push(turn);
          turn.say("claude ok");
        },
      }),
    ]),
  });
}

function primaryIdOf(w: Awaited<ReturnType<typeof world>>): string {
  return w.host.db
    .query<{ id: string }, []>("SELECT id FROM machine WHERE kind = 'primary'")
    .get()!.id;
}

describe("external runtime rule 1: no persona anywhere", () => {
  it("refuses persona on create/update and auto-clears on transition or legacy update", async () => {
    const turns: ScriptedTurn[] = [];
    const { models, requests } = scriptedModels(() => say("eta ok"));
    const w = await world({
      models,
      runtimes: oarClaude(turns),
      captain: true,
    });
    const primaryId = primaryIdOf(w);

    // Create refuses non-empty persona for OAR and ACP runtimes.
    await expect(
      w.client.call("agents", "create", {
        name: "Cody",
        runtime: "claude",
        machineId: primaryId,
        persona: "Executor",
      }),
    ).rejects.toThrow(/cannot take a persona card/);
    await expect(
      w.client.call("agents", "create", {
        name: "Ace",
        runtime: "acp.fake",
        machineId: primaryId,
        persona: "Executor",
      }),
    ).rejects.toThrow(/cannot take a persona card/);

    // Built-in eta keeps its persona card cleanly.
    const ada = await w.agent("Ada", { persona: "Executor" });
    expect(ada.persona).toBe("Executor");

    // Moving eta -> external with an explicit non-empty persona is refused.
    await expect(
      w.client.call("agents", "update", {
        agentId: ada.id,
        runtime: "claude",
        machineId: primaryId,
        persona: "Executor",
      }),
    ).rejects.toThrow(/cannot take a persona card/);

    // Moving eta -> external without passing persona auto-clears it.
    const { agent: moved } = (await w.client.call("agents", "update", {
      agentId: ada.id,
      runtime: "claude",
      machineId: primaryId,
    })) as { agent: AgentView };
    expect(moved).toMatchObject({ runtime: "claude", persona: "" });

    // Legacy external DB row carrying a non-empty persona: explicit non-empty persona update fails,
    // unrelated edit auto-clears persona, and local session open never attaches persona.
    const cody = await w.agent("Cody", {
      runtime: "claude",
      machineId: primaryId,
    });
    w.host.db
      .query("UPDATE agent SET persona = 'Executor' WHERE id = ?")
      .run(cody.id);
    await expect(
      w.client.call("agents", "update", {
        agentId: cody.id,
        persona: "Executor",
      }),
    ).rejects.toThrow(/cannot take a persona card/);

    // Before clearing: LocalPlace defense-in-depth never passes persona to external session.
    const group = await w.group(cody.homeProjectId, [cody.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "hello");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(requests).toHaveLength(0);
    expect(turns).toHaveLength(1);
    const sid = sessionOf(w, group.id)!;
    const listed = (await w.host.server.sessions.list()).find(
      (s) => s.id === sid,
    );
    expect(
      listed?.ok === true ? listed.meta.persona : "unexpected",
    ).toBeUndefined();

    // Unrelated update without passing persona auto-clears legacy DB persona.
    const { agent: renamed } = (await w.client.call("agents", "update", {
      agentId: cody.id,
      name: "Cody 2",
    })) as { agent: AgentView };
    expect(renamed.persona).toBe("");
  });

  it("enforces no-persona across Captain propose_agent and setPrompt", async () => {
    const w = await world({ captain: true, tasks: { runs: false } });
    const primaryId = primaryIdOf(w);
    const { conversationId: captain } = await w.host.product.captain.direct();

    // Captain propose_agent accepts omitted or empty persona on external runtime + valid machineId.
    const { operation } = await w.host.product.captain.proposals.propose(
      w.host.product.captain.propose.agent,
      {
        name: "ExternalCody",
        purpose: "Run claude tasks.",
        instructions: "Work carefully.",
        model: "claude:sonnet",
        runtime: "claude",
        machineId: primaryId,
      },
      captain,
    );
    expect(operation.payload).toMatchObject({
      runtime: "claude",
      persona: "",
      machineId: primaryId,
    });

    const decided = (await w.client.call("captain", "decideOperation", {
      operationId: operation.id,
      decision: "approve",
    })) as { operation: { status: string; result?: { agentId: string } } };
    expect(decided.operation.status).toBe("applied");
    const codyId = decided.operation.result!.agentId;
    const cody = w.host.db
      .query<
        { runtime: string; persona: string; machineId: string | null },
        [string]
      >(
        "SELECT runtime, persona, machine_id AS machineId FROM agent WHERE id = ?",
      )
      .get(codyId)!;
    expect(cody).toEqual({
      runtime: "claude",
      persona: "",
      machineId: primaryId,
    });

    // setPrompt with kind "persona" rejects non-empty content on external agents.
    expect(() =>
      w.host.product.captain.setPrompt({
        subjectId: codyId,
        kind: "persona",
        content: "Executor",
      }),
    ).toThrow(/cannot take a persona card/);

    // RemotePlace / daemon defense-in-depth ignores persona & personaCards for external sessions.
    const r = await remoteWorld({}, { node: { runtimes: oarClaude() } });
    const remoteCody = await r.agent("RemoteCody", {
      runtime: "claude",
      machineId: r.daemon.machineId,
    });
    r.host.db
      .query("UPDATE agent SET persona = 'Executor' WHERE id = ?")
      .run(remoteCody.id);
    const remoteGroup = await r.group(r.remoteProject.id, [remoteCody.id]);
    await r.watch(remoteGroup.id);
    const sent = await r.send(remoteGroup.id, "hi");
    const done = await r.settled(remoteGroup.id, sent.replies[0]!.id);
    expect(done.status).toBe("done");
    const openFrame = r.traffic.in
      .map(
        (raw) =>
          JSON.parse(raw) as {
            action?: string;
            args?: Record<string, unknown>;
          },
      )
      .find((frame) => frame.action === "open");
    expect(openFrame?.args?.persona).toBeUndefined();
    expect(openFrame?.args?.personaCards).toBeUndefined();
  });

  it("never applies eta harness defaults (persona, thinkingLevel) to local or remote external sessions", async () => {
    const r = await remoteWorld(
      { runtimes: oarClaude() },
      { node: { runtimes: oarClaude() } },
    );
    await r.client.call("settings", "save", {
      persona: "Executor",
      thinkingLevel: "high",
    });

    const primaryId = primaryIdOf(r);
    const localExt = await r.agent("LocalExt", {
      runtime: "claude",
      machineId: primaryId,
    });
    const localProj = await r.project({ machineId: primaryId });
    const localGroup = await r.group(localProj.id, [localExt.id]);
    await r.watch(localGroup.id);
    const localSent = await r.send(localGroup.id, "hi local");
    const localDone = await r.settled(localGroup.id, localSent.replies[0]!.id);
    expect(localDone.status).toBe("done");
    const localSid = sessionOf(r, localGroup.id)!;
    const localManaged = await r.host.server.sessions.session(localSid);
    expect(localManaged?.meta.persona).toBeUndefined();
    expect(localManaged?.session.kernel.config.read("thinkingLevel")).not.toBe(
      "high",
    );

    const remoteExt = await r.agent("RemoteExt", {
      runtime: "claude",
      machineId: r.daemon.machineId,
    });
    const remoteGroup = await r.group(r.remoteProject.id, [remoteExt.id]);
    await r.watch(remoteGroup.id);
    const remoteSent = await r.send(remoteGroup.id, "hi remote");
    const remoteDone = await r.settled(
      remoteGroup.id,
      remoteSent.replies[0]!.id,
    );
    expect(remoteDone.status).toBe("done");
    const openFrame = r.traffic.in
      .map(
        (raw) =>
          JSON.parse(raw) as {
            action?: string;
            args?: Record<string, unknown>;
          },
      )
      .find(
        (frame) =>
          frame.action === "open" && frame.args?.agentId === remoteExt.id,
      );
    expect(openFrame?.args?.persona).toBeUndefined();
    expect(openFrame?.args?.personaCards).toBeUndefined();
    expect(openFrame?.args?.thinkingLevel).toBeUndefined();
  });
});

describe("external runtime rule 2: single-machine only, no cross-machine use", () => {
  it("requires valid non-null machineId on create/update and guards machine changes by active regular groups", async () => {
    const r = await remoteWorld({ tasks: { runs: false } });
    const primaryId = primaryIdOf(r);
    const daemonId = r.daemon.machineId;
    await r.client.call("machines", "rename", {
      machineId: primaryId,
      name: "desk",
    });
    await r.client.call("machines", "rename", {
      machineId: daemonId,
      name: "laptop",
    });

    // Create refuses omitted or null machineId on OAR & ACP runtimes.
    await expect(
      r.client.call("agents", "create", {
        name: "NoPinClaude",
        runtime: "claude",
      }),
    ).rejects.toThrow(/must be pinned to a machine/);
    await expect(
      r.client.call("agents", "create", {
        name: "NullPinAcp",
        runtime: "acp.fake",
        machineId: null,
      }),
    ).rejects.toThrow(/must be pinned to a machine/);

    // Revoked / pending machines are refused.
    const pendingRowId = crypto.randomUUID();
    r.host.db
      .query(
        "INSERT INTO machine (id, kind, name, status, created_at) VALUES (?, 'daemon', 'tablet', 'pending', ?)",
      )
      .run(pendingRowId, Date.now());
    await expect(
      r.client.call("agents", "create", {
        name: "PendingClaude",
        runtime: "claude",
        machineId: pendingRowId,
      }),
    ).rejects.toThrow(/pending/);

    // Cannot clear machineId to null on update, nor switch eta -> external while machineId is null.
    const cody = await r.agent("Cody", {
      runtime: "claude",
      machineId: primaryId,
    });
    await expect(
      r.client.call("agents", "update", { agentId: cody.id, machineId: null }),
    ).rejects.toThrow(/must be pinned to a machine/);

    const eta = await r.agent("Ada", { machineId: null });
    await expect(
      r.client.call("agents", "update", { agentId: eta.id, runtime: "codex" }),
    ).rejects.toThrow(/must be pinned to a machine/);

    // Add Ada to a regular group on desk (primary), then forbid switching eta -> claude pinned to laptop.
    const primaryProj = await r.project({ machineId: primaryId });
    const deskGroup = await r.group(primaryProj.id, [eta.id], "desk-room");
    await expect(
      r.client.call("agents", "update", {
        agentId: eta.id,
        runtime: "claude",
        machineId: daemonId,
      }),
    ).rejects.toThrow(/desk-room/);

    // Cody in a regular group on desk cannot be moved to laptop while desk-room is active,
    // but unrelated edits (name/model/instructions) keeping machineId unchanged succeed.
    const codyGroup = await r.group(primaryProj.id, [cody.id], "cody-room");
    await expect(
      r.client.call("agents", "update", {
        agentId: cody.id,
        machineId: daemonId,
      }),
    ).rejects.toThrow(/cody-room/);

    // Legacy cross-machine participant does NOT block unrelated edits (name/model/instructions).
    r.host.db
      .query(
        "INSERT INTO conversation (id, project_id, kind, name, created_at, updated_at) VALUES ('legacy-g', ?, 'group', 'legacy-room', 1, 1)",
      )
      .run(r.remoteProject.id);
    r.host.db
      .query(
        "INSERT INTO participant (conversation_id, agent_id, last_seq, invited_at) VALUES ('legacy-g', ?, 0, 1)",
      )
      .run(cody.id);
    const { agent: edited } = (await r.client.call("agents", "update", {
      agentId: cody.id,
      name: "Cody Edited",
      instructions: "Updated",
    })) as { agent: AgentView };
    expect(edited).toMatchObject({ name: "Cody Edited", machineId: primaryId });

    // Archive both regular groups on other machines -> re-pinning to laptop succeeds.
    await r.client.call("conversations", "update", {
      conversationId: codyGroup.id,
      archived: true,
    });
    r.host.db
      .query("UPDATE conversation SET archived = 1 WHERE id = 'legacy-g'")
      .run();
    const { agent: repinned } = (await r.client.call("agents", "update", {
      agentId: cody.id,
      machineId: daemonId,
    })) as { agent: AgentView };
    expect(repinned.machineId).toBe(daemonId);

    // Built-in eta keeps follow-project (`null`) and cross-machine pinning.
    const { agent: etaMoved } = (await r.client.call("agents", "update", {
      agentId: eta.id,
      machineId: daemonId,
    })) as { agent: AgentView };
    expect(etaMoved.machineId).toBe(daemonId);
    const etaGroup = await r.group(primaryProj.id, [eta.id], "eta-ok");
    expect(etaGroup.id).toBeTruthy();
    expect(deskGroup.id).toBeTruthy();
  });

  it("refuses cross-machine groups, invites, Captain propose_group, and task creation/drafts/mentions", async () => {
    const r = await remoteWorld({ captain: true, tasks: { runs: false } });
    const primaryId = primaryIdOf(r);
    const daemonId = r.daemon.machineId;
    await r.client.call("machines", "rename", {
      machineId: primaryId,
      name: "desk",
    });
    await r.client.call("machines", "rename", {
      machineId: daemonId,
      name: "laptop",
    });

    const primaryProj = await r.project({ machineId: primaryId });
    const ada = await r.agent("Ada");
    const primaryClaude = await r.agent("PrimaryClaude", {
      runtime: "claude",
      machineId: primaryId,
    });
    const laptopAcp = await r.agent("LaptopAcp", {
      runtime: "acp.fake",
      machineId: daemonId,
    });

    // createGroup / conversations.create refuses cross-machine external agents.
    await expect(
      r.group(r.remoteProject.id, [primaryClaude.id]),
    ).rejects.toThrow(/desk.*laptop/);
    await expect(r.group(primaryProj.id, [laptopAcp.id])).rejects.toThrow(
      /laptop.*desk/,
    );

    // conversations.invite refuses cross-machine external agents.
    const primaryGroup = await r.group(primaryProj.id, [ada.id]);
    await expect(
      r.client.call("conversations", "invite", {
        conversationId: primaryGroup.id,
        agentId: laptopAcp.id,
      }),
    ).rejects.toThrow(/laptop.*desk/);

    // Same-machine invite works.
    await r.client.call("conversations", "invite", {
      conversationId: primaryGroup.id,
      agentId: primaryClaude.id,
    });

    // Captain propose_group refuses cross-machine external agents on existing and new directories.
    const { conversationId: captain } = await r.host.product.captain.direct();
    await expect(
      r.host.product.captain.proposals.propose(
        r.host.product.captain.propose.group,
        {
          name: "bad-remote-group",
          projectId: r.remoteProject.id,
          memberIds: [primaryClaude.id],
        },
        captain,
      ),
    ).rejects.toThrow(/desk.*laptop/);

    const newDir = await tempDir("eta-cap-dir-");
    await expect(
      r.host.product.captain.proposals.propose(
        r.host.product.captain.propose.group,
        {
          name: "bad-new-dir-group",
          path: newDir,
          machineId: daemonId,
          memberIds: [primaryClaude.id],
        },
        captain,
      ),
    ).rejects.toThrow(/desk.*laptop/);

    // Tasks: TaskBoard.create, TaskBoard.make, TaskCards.draft, TaskCards.confirm, TaskBoard.comment mentions.
    // Simulate legacy participants so assigneeScope includes them cleanly and checkExternalAgentProject runs directly.
    const daemonGroup = await r.group(r.remoteProject.id, [ada.id]);
    r.host.db
      .query(
        "INSERT INTO participant (conversation_id, agent_id, last_seq, invited_at) VALUES (?, ?, 0, 1)",
      )
      .run(daemonGroup.id, primaryClaude.id);
    r.host.db
      .query(
        "INSERT INTO participant (conversation_id, agent_id, last_seq, invited_at) VALUES (?, ?, 0, 1)",
      )
      .run(primaryGroup.id, laptopAcp.id);

    // 1. TaskBoard.create (assignee on wrong machine)
    expect(() =>
      r.host.product.board.create(
        {
          title: "Wrong machine assignee",
          description: "Do it",
          status: "todo",
          conversationId: daemonGroup.id,
          workspace: "local",
          assignee: primaryClaude.id,
        },
        { kind: "agent", agentId: ada.id },
      ),
    ).toThrow(/desk.*laptop/);

    // 2. TaskBoard.make (`tasks.create`)
    await expect(
      r.client.call("tasks", "create", {
        conversationId: primaryGroup.id,
        tasks: [
          {
            title: "Cross machine task",
            description: "Nope",
            assignee: laptopAcp.id,
          },
        ],
        status: "todo",
      }),
    ).rejects.toThrow(/laptop.*desk/);

    // 3. TaskCards.draft refuses cross-machine assignee (and external self-drafter).
    expect(() =>
      r.host.product.board.draft({
        conversationId: primaryGroup.id,
        agentId: ada.id,
        draft: {
          title: "Draft for wrong machine",
          goal: "g",
          acceptance: "a",
          workspace: "local",
          assignee: laptopAcp.id,
        },
      }),
    ).toThrow(/laptop.*desk/);

    // 4. TaskCards.confirm refuses if assignee/drafter violated or agent moved before confirm.
    const portableCody = await r.agent("PortableCody", {
      runtime: "claude",
      machineId: primaryId,
    });
    await r.client.call("conversations", "invite", {
      conversationId: primaryGroup.id,
      agentId: portableCody.id,
    });
    const draftMsg = r.host.product.board.draft({
      conversationId: primaryGroup.id,
      agentId: ada.id,
      draft: {
        title: "Portable task",
        goal: "g",
        acceptance: "a",
        workspace: "local",
        assignee: portableCody.id,
      },
    });
    // Re-pin portableCody to laptop directly in DB (simulating drift before confirm).
    r.host.db
      .query("UPDATE agent SET machine_id = ? WHERE id = ?")
      .run(daemonId, portableCody.id);
    await expect(
      r.client.call("tasks", "confirmDraft", {
        conversationId: primaryGroup.id,
        messageId: draftMsg.id,
      }),
    ).rejects.toThrow(/laptop.*desk/);

    // 5. TaskBoard.comment mentions refuse cross-machine external agent even on standalone/Captain tasks.
    const adaTask = r.host.product.board.create(
      {
        title: "Ada primary task",
        description: "Work on primary",
        status: "backlog",
        conversationId: primaryGroup.id,
        workspace: "local",
        assignee: ada.id,
      },
      { kind: "agent", agentId: ada.id },
    );
    await expect(
      r.client.call("tasks", "comment", {
        taskId: adaTask.id,
        body: `@${laptopAcp.name} please look`,
        mentions: [laptopAcp.id],
      }),
    ).rejects.toThrow(/laptop.*desk/);
  });

  it("fails legacy cross-machine replies and task runs cleanly while allowing agent_home 1-on-1 chat on daemon", async () => {
    const dataDir = await tempDir("eta-daemon-acp-");
    const fake = fakeAgent("fake");
    mkdirSync(join(dataDir, ".eta"), { recursive: true });
    writeFileSync(
      join(dataDir, ".eta", "acp.json"),
      JSON.stringify({ agents: [fake.config] }),
    );
    const { models } = scriptedModels(() => {
      throw new Error("eta model must not run for external agent");
    });
    const daemonTurns: ScriptedTurn[] = [];
    const r = await remoteWorld(
      { models },
      { dataDir, node: { runtimes: oarClaude(daemonTurns) } },
    );
    const primaryId = primaryIdOf(r);
    const daemonId = r.daemon.machineId;
    await r.client.call("machines", "rename", {
      machineId: primaryId,
      name: "desk",
    });
    await r.client.call("machines", "rename", {
      machineId: daemonId,
      name: "laptop",
    });

    // Daemon-pinned external agent keeps working in its own agent_home (whose project row lives on primary).
    const laptopCody = await r.agent("LaptopCody", {
      runtime: "claude",
      machineId: daemonId,
    });
    expect(
      r.host.db
        .query<{ kind: string }, [string]>(
          "SELECT kind FROM project WHERE id = ?",
        )
        .get(laptopCody.homeProjectId)?.kind,
    ).toBe("agent_home");
    const homeGroup = await r.group(laptopCody.homeProjectId, [laptopCody.id]);
    await r.watch(homeGroup.id);
    const homeSent = await r.send(homeGroup.id, "hello at home");
    const homeDone = await r.settled(homeGroup.id, homeSent.replies[0]!.id);
    expect(homeDone).toMatchObject({ status: "done", text: "claude ok" });
    expect(daemonTurns).toHaveLength(1);

    // Seed a legacy cross-machine participant (agent created on primary, added to primary group, then pinned to daemon in DB)
    // -> reply fails cleanly naming both machines without opening a session on daemon or falling back to desk.
    const primaryProj = await r.project({ machineId: primaryId });
    const legacyChat = await r.group(primaryProj.id, [
      laptopCody.id === "" ? laptopCody.id : (await r.agent("AdaForLegacy")).id,
    ]);
    r.host.db
      .query(
        "INSERT INTO participant (conversation_id, agent_id, last_seq, invited_at) VALUES (?, ?, 0, 1)",
      )
      .run(legacyChat.id, laptopCody.id);
    await r.watch(legacyChat.id);
    const crossSent = await r.send(
      legacyChat.id,
      `@${laptopCody.name} run on desk?`,
      {
        mentions: [laptopCody.id],
      },
    );
    const crossFailed = await r.settled(
      legacyChat.id,
      crossSent.replies[0]!.id,
      ["done", "failed"],
    );
    expect(crossFailed.status).toBe("failed");
    expect(crossFailed.text).toContain("laptop");
    expect(crossFailed.text).toContain("desk");
    // Daemon session was NOT opened a second time for the cross-machine reply.
    expect(daemonTurns).toHaveLength(1);

    // Seed a legacy cross-machine task (acp.fake pinned to daemon, task moved to primary project in DB) -> run fails cleanly naming both machines.
    const laptopAcp = await r.agent("LaptopAcp", {
      runtime: "acp.fake",
      machineId: daemonId,
    });
    const laptopGroup = await r.group(r.remoteProject.id, [laptopAcp.id]);
    const seededTask = r.host.product.board.create(
      {
        title: "Legacy cross task",
        description: "Should fail before running",
        status: "backlog",
        conversationId: laptopGroup.id,
        assignee: laptopAcp.id,
        workspace: "local",
      },
      { kind: "agent", agentId: laptopAcp.id },
    );
    r.host.db
      .query("UPDATE task SET project_id = ? WHERE id = ?")
      .run(primaryProj.id, seededTask.id);
    await r.client.call("tasks", "update", {
      taskId: seededTask.id,
      status: "todo",
    });
    await until(
      () =>
        r.host.product.board.detail(seededTask.id)?.runs.at(-1)?.status ===
        "failed",
      10_000,
    );
    const failedRun = r.host.product.board.detail(seededTask.id)!.runs.at(-1)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("laptop");
    expect(failedRun.error).toContain("desk");
    expect(failedRun.sessionId).toBeNull();
  });
});
