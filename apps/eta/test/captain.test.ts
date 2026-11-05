/**
 * El Capitan's product boundary: one system identity, visible group authorization, task
 * provenance, protected prompts/settings, memory pauses and the operational supervisor.
 *
 * These tests use the real host/database/wire path where that is useful. Captain's session tools
 * themselves are exercised through the scripted model in the assignment tests, so the important
 * distinction is observable: Captain sends the instruction; the assigned agent creates the task.
 */
import type { CaptainIdentityView } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const options = { captain: true, tasks: { runs: false } } as const;

async function captainWorld() {
  const { models, requests } = scriptedModels(() => say("Captain ready."));
  const w = await world({ ...options, models });
  return { w, models, requests };
}

describe("captain identity", () => {
  it("is one system agent and cannot be managed as an ordinary agent", async () => {
    const { w } = await captainWorld();
    const identity = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
      created: boolean;
    };
    const again = (await w.client.call("captain", "ensure", {})) as {
      identity: CaptainIdentityView;
      created: boolean;
    };
    expect(identity.created).toBe(false);
    expect(again.identity.agentId).toBe(identity.identity.agentId);
    expect(
      w.host.db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM agent WHERE system_role = 'captain'",
        )
        .get()!.n,
    ).toBe(1);

    await expect(
      w.client.call("agents", "update", {
        agentId: identity.identity.agentId,
        model: "fake:not-captain",
      }),
    ).rejects.toThrow(/Captain/);
    await expect(
      w.client.call("agents", "delete", {
        agentId: identity.identity.agentId,
      }),
    ).rejects.toThrow(/Captain/);
    expect(
      w.host.server.mounted().some((plugin) => plugin.name === "captain"),
    ).toBe(true);
    const direct = (await w.client.call("captain", "direct", {})) as {
      identity: CaptainIdentityView;
      conversationId: string;
    };
    w.client.subscribe(`conversations.${direct.conversationId}`);
    await until(
      () =>
        w.client.section(`conversations.${direct.conversationId}`, "info") !==
        undefined,
    );
    expect(
      w.client.section(`conversations.${direct.conversationId}`, "info"),
    ).toMatchObject({ id: direct.conversationId, kind: "direct" });
  });
});

describe("captain assignment", () => {
  it("authorizes an agent to create its own task without task.assignee", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("I made the task.")
        : call("create_task", {
            title: "Ship the Captain patch",
            description: "Do the implementation",
            workspace: "local",
          }),
    );
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "release");
    await w.watch(group.id);

    const result = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, implement the release fix.",
      agentIds: [ada.id],
    });
    await until(() => {
      const row = w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get();
      return row?.n === 1;
    });

    const message = w.row(group.id, result.messageId)!;
    expect(message).toMatchObject({
      author: "captain",
      agentId: (await w.host.product.captain.identity())!.agentId,
    });
    expect(message.data.captainAssignmentId).toBe(result.assignment.id);
    const task = w.host.db
      .query<
        {
          created_by_agent: string;
          assignee_agent: string | null;
          captain_assignment_id: string;
          captain_message_id: string;
        },
        []
      >(
        `SELECT created_by_agent, assignee_agent, captain_assignment_id,
                captain_message_id
           FROM task`,
      )
      .get()!;
    expect(task).toEqual({
      created_by_agent: ada.id,
      assignee_agent: null,
      captain_assignment_id: result.assignment.id,
      captain_message_id: result.messageId,
    });
    const assignment = w.host.product.captain.store.assignment(
      result.assignment.id,
    )!;
    expect(assignment.targets[0]).toMatchObject({
      agentId: ada.id,
      taskCount: 1,
      status: "working",
    });
  });

  it("carries several targets in one assignment", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("done")
        : call("create_task", {
            title: "Parallel work",
            description: "One task for each assigned agent",
            workspace: "local",
          }),
    );
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const bola = await w.agent("Bola");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id, bola.id], "parallel");
    await w.watch(group.id);

    const result = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Both of you take one part.",
      agentIds: [ada.id, bola.id],
    });
    await until(() => {
      const row = w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get();
      return row?.n === 2;
    });
    expect(result.assignment.targets.map((target) => target.agentId)).toEqual([
      ada.id,
      bola.id,
    ]);
    expect(
      w.host.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM task WHERE captain_assignment_id = ?",
        )
        .get(result.assignment.id)!.n,
    ).toBe(2);
  });

  it("does not let a target turn a Captain assignment into task.assignee", async () => {
    let heard = "";
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") {
        heard = request.last;
        return say("done");
      }
      return call("create_task", {
        title: "Wrong handoff",
        description: "Must stay with the assigned agent",
        workspace: "local",
        assignee: "another-agent",
      });
    });
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "handoff");
    await w.watch(group.id);
    const result = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, make the fix.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, result.replyIds[0]!);
    expect(heard).toMatch(
      /Do not pass|does not use task.assignee|create the task yourself/,
    );
    expect(
      w.host.db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task")
        .get()!.n,
    ).toBe(0);
  });

  it("keeps provenance when the assigned agent drafts and the user confirms", async () => {
    const { models } = scriptedModels((request) =>
      request.lastRole === "toolResult"
        ? say("Drafted.")
        : call("draft_task", {
            title: "Drafted under Captain",
            goal: "Keep the source visible",
            acceptance: "The task names the assignment",
            workspace: "local",
          }),
    );
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "draft-work");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, draft the follow-up.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const draft = w.rows(group.id).find((row) => row.kind === "task_draft")!;
    const confirmed = (await w.client.call("tasks", "confirmDraft", {
      conversationId: group.id,
      messageId: draft.id,
    })) as {
      task: {
        captainAssignmentId?: string | null;
        captainMessageId?: string | null;
      };
    };
    expect(confirmed.task.captainAssignmentId).toBe(assigned.assignment.id);
    expect(confirmed.task.captainMessageId).toBe(assigned.messageId);
    expect(
      w.host.product.captain.store.assignment(assigned.assignment.id)!
        .targets[0],
    ).toMatchObject({ agentId: ada.id, taskCount: 1, status: "working" });
  });
});

describe("captain controls", () => {
  it("sets Captain's model through its own target and updates the open session", async () => {
    const { w } = await captainWorld();
    const direct = await w.host.product.captain.direct();
    const captainId = direct.agentId;
    await w.watch(direct.conversationId);
    const sent = await w.send(direct.conversationId, "hello");
    await w.settled(direct.conversationId, sent.replies[0]!.id);
    const sessionId = w.client.section<{ sessionId: string }[]>(
      `conversations.${direct.conversationId}`,
      "members",
    )![0]!.sessionId;
    const config = () =>
      w.host.server.sessions
        .openSessions()
        .find((entry) => entry.meta.id === sessionId)!.session.kernel.config;

    await expect(
      w.client.call("captain", "setModel", { model: "not-a-model" }),
    ).rejects.toThrow(/provider:modelId/);
    const saved = (await w.client.call("captain", "setModel", {
      model: "fake:chosen",
    })) as { identity: CaptainIdentityView };

    expect(saved.identity).toMatchObject({
      agentId: captainId,
      model: "fake:chosen",
    });
    expect(
      w.host.db
        .query<{ model: string | null }, [string]>(
          "SELECT model FROM agent WHERE id = ?",
        )
        .get(captainId),
    ).toEqual({ model: "fake:chosen" });
    expect(config().read("model")).toEqual({
      provider: "fake",
      modelId: "chosen",
    });
    expect(
      w.host.server.sessions
        .openSessions()
        .some((entry) => entry.meta.id === sessionId),
    ).toBe(true);
  });

  it("pauses memory for conversations and task runs", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "memory");
    const task = w.host.product.board.create(
      {
        title: "Memory task",
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );

    await w.client.call("captain", "setMemoryPaused", {
      scopeType: "conversation",
      scopeId: group.id,
      paused: true,
    });
    expect(
      w.host.product.captain.memoryEnabled({
        id: "session",
        createdAt: Date.now(),
        cwd: project.path,
        conversationId: group.id,
        agentId: ada.id,
      }),
    ).toBe(false);

    await w.client.call("captain", "setMemoryPaused", {
      scopeType: "task",
      scopeId: task.id,
      paused: true,
    });
    expect(
      w.host.product.captain.memoryEnabled({
        id: "task-session",
        createdAt: Date.now(),
        cwd: project.path,
        conversationId: `task:${task.id}`,
        agentId: ada.id,
      }),
    ).toBe(false);
  });

  it("versions prompts and settings, and protects the global and Captain prompts", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const first = w.host.product.captain.setPrompt({
      subjectId: ada.id,
      kind: "instructions",
      content: "First instructions",
    });
    const second = w.host.product.captain.setPrompt({
      subjectId: ada.id,
      kind: "instructions",
      content: "Second instructions",
    });
    expect(second.version).toBe(first.version + 1);
    expect(
      w.host.product.captain.promptDiff(
        ada.id,
        "instructions",
        first.version,
        second.version,
      ).diff,
    ).toContain("+Second instructions");
    expect(
      w.host.product.captain.rollbackPrompt({
        subjectId: ada.id,
        kind: "instructions",
        version: first.version,
      }).content,
    ).toBe("First instructions");

    const setting = w.host.product.captain.setSetting("retryLimit", 3);
    expect(setting.value).toBe(3);
    expect(w.host.product.captain.rollbackSetting("retryLimit", 1).value).toBe(
      3,
    );

    const captain = w.host.product.captain.identity()!;
    await expect(
      w.client.call("captain", "setPrompt", {
        subjectId: captain.agentId,
        kind: "persona",
        content: "must be approved",
      }),
    ).rejects.toThrow(/approved Captain operation/);

    const operation = w.host.product.captain.createOperation({
      kind: "set_prompt",
      requiresApproval: true,
      payload: {
        subjectId: captain.agentId,
        kind: "persona",
        content: "approved persona",
      },
    });
    const applied = await w.host.product.captain.decideOperation(
      operation.id,
      "approve",
    );
    expect(applied.status).toBe("applied");
    expect(w.host.product.captain.store.captainAgent()?.persona).toBe(
      "approved persona",
    );

    const base = w.host.product.captain.createOperation({
      kind: "set_prompt",
      requiresApproval: true,
      payload: {
        subjectId: "global",
        kind: "base",
        content: "A new base.",
      },
    });
    expect(
      await w.host.product.captain.decideOperation(base.id, "approve"),
    ).toMatchObject({ status: "applied" });
    expect(w.host.product.baseSystemPromptFor()).toBe("A new base.");
  });

  it("redacts credentials from text and structured tool results", async () => {
    const { redactJson, redactToolResult } = await import(
      "../src/captain/redact"
    );
    expect(
      redactJson({ authorization: "Bearer sk-123456789012345" }),
    ).toContain("[REDACTED:secret]");
    const result = redactToolResult({
      content: [{ type: "text", text: "token sk-123456789012345" }],
      details: { password: "secret", nested: "Bearer abcdefghijklmnop" },
    }) as { content: { text: string }[]; details: Record<string, string> };
    expect(result.content[0]!.text).not.toContain("sk-123456789012345");
    expect(result.details.password).toBe("[REDACTED:secret]");
    expect(result.details.nested).toContain("[REDACTED:secret]");
  });

  it("continues a task through the group instead of taking it over", async () => {
    const { models } = scriptedModels(() => say("I will continue."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "continued");
    await w.watch(group.id);
    const task = w.host.product.board.create(
      {
        title: "Needs another round",
        conversationId: group.id,
        workspace: "local",
        status: "in_review",
      },
      { kind: "agent", agentId: ada.id },
    );
    await w.host.product.captain.taskControl({
      taskId: task.id,
      action: "continue",
      text: "Please continue #1 and report back.",
    });
    await until(() =>
      w
        .rows(group.id)
        .some(
          (row) =>
            row.author === "captain" && row.text.includes("Please continue #1"),
        ),
    );
    expect(
      w.host.db
        .query<
          { created_by_agent: string; assignee_agent: string | null },
          [string]
        >("SELECT created_by_agent, assignee_agent FROM task WHERE id = ?")
        .get(task.id),
    ).toEqual({ created_by_agent: ada.id, assignee_agent: null });
  });

  it("stops automatic retries after five consecutive failures", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "retry");
    const task = w.host.product.board.create(
      {
        title: "Retry me",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    const runs = w.host.product.captain.store;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // A failed run is what the supervisor sees; the run store is reached through the product's
      // board while this test is deliberately kept about the policy boundary.
      w.host.db
        .query(
          `INSERT INTO task_run (id, task_id, machine_id, status, error, created_at)
           VALUES (?, ?, ?, 'failed', 'test failure', ?)`,
        )
        .run(crypto.randomUUID(), task.id, primary.id, Date.now() + attempt);
      w.host.product.captainSupervisor.tick();
      expect(runs.retryState(task.id).attempts).toBe(attempt);
      const failures = w.host.product.captain.store
        .reviews()
        .filter((review) => review.kind === "task_failure");
      expect(failures).toHaveLength(attempt < 5 ? 0 : 1);
    }
    expect(runs.retryState(task.id).stoppedAt).not.toBeNull();
    expect(
      w.host.product.captain.store
        .notifications()
        .some((notification) => notification.kind === "task_retry_stopped"),
    ).toBe(true);
  });

  it("asks Captain immediately for a non-retryable task failure", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "credentials");
    const task = w.host.product.board.create(
      {
        title: "Needs a key",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        task.id,
        primary.id,
        "OpenAI API error (401): api_key_revoked",
        Date.now(),
        Date.now(),
        Date.now(),
      );

    w.host.product.captainSupervisor.tick();
    const review = w.host.product.captain.store
      .reviews()
      .find((item) => item.taskId === task.id)!;
    expect(review).toMatchObject({
      kind: "task_failure_non_retryable",
      status: expect.stringMatching(/pending|running|completed/),
    });
    expect(
      w.host.product.captain.store.retryState(task.id).stoppedAt,
    ).not.toBeNull();
    expect(w.host.product.captain.store.retryState(task.id).attempts).toBe(1);
  });

  it("marks an inactive task stuck and reserves proactive wake events", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "stuck");
    const task = w.host.product.board.create(
      {
        title: "Quiet task",
        conversationId: group.id,
        workspace: "local",
        status: "todo",
      },
      { kind: "agent", agentId: ada.id },
    );
    w.host.db
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(Date.now() - 31 * 60_000, task.id);
    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_stalled" && review.taskId === task.id,
        ),
    ).toBe(true);

    const events: string[] = [];
    const off = w.host.product.captainSupervisor.onEvent((event) =>
      events.push(event.kind),
    );
    w.host.product.captainSupervisor.wake({ kind: "reserved" });
    off();
    w.host.product.captainSupervisor.wake({ kind: "ignored" });
    expect(events).toEqual(["reserved"]);
  });

  it("distinguishes a stopped task from a run with no progress", async () => {
    const { w } = await captainWorld();
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "stuck-run");
    const task = w.host.product.board.create(
      {
        title: "Hung run",
        conversationId: group.id,
        workspace: "local",
        status: "in_progress",
      },
      { kind: "agent", agentId: ada.id },
    );
    const primary = w.host.db
      .query<{ id: string }, []>(
        "SELECT id FROM machine WHERE kind = 'primary'",
      )
      .get()!;
    const started = Date.now() - 31 * 60_000;
    w.host.db
      .query(
        `INSERT INTO task_run
           (id, task_id, machine_id, status, created_at, started_at)
         VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(crypto.randomUUID(), task.id, primary.id, started, started);
    w.host.db
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(started, task.id);

    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .some(
          (review) =>
            review.kind === "task_run_stuck" && review.taskId === task.id,
        ),
    ).toBe(true);
  });

  it("wakes Captain once when an assignment settles without a task", async () => {
    const { models } = scriptedModels(() => say("Verified."));
    const w = await world({ ...options, models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id], "settled");
    await w.watch(group.id);
    const assigned = await w.host.product.captain.assign({
      conversationId: group.id,
      text: "Ada, inspect it and report.",
      agentIds: [ada.id],
    });
    await w.settled(group.id, assigned.replyIds[0]!);
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);

    w.host.product.captainSupervisor.tick();
    await until(() =>
      w
        .rows(direct.conversationId)
        .some(
          (row) =>
            row.author === "system" && row.text.includes("<captain-review>"),
        ),
    );
    w.host.product.captainSupervisor.tick();
    expect(
      w.host.product.captain.store
        .reviews()
        .filter((review) => review.assignmentId === assigned.assignment.id),
    ).toHaveLength(1);
  });

  it("waits while Captain is busy and then delivers a batched review", async () => {
    const { models } = scriptedModels((request) =>
      request.index === 0 ? HANG : say("Reviewed."),
    );
    const w = await world({ ...options, models });
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    const sent = await w.send(direct.conversationId, "stay busy");
    await until(
      () =>
        w.row(direct.conversationId, sent.replies[0]!.id)?.status === "working",
    );

    const store = w.host.product.captain.store;
    const first = store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:batch:1",
      body: "First review.",
    });
    const second = store.createReview({
      kind: "task_run_stuck",
      dedupeKey: "test:batch:2",
      body: "Second review.",
    });
    await w.host.product.captain.observeReviews();
    expect(
      w.rows(direct.conversationId).some((row) => row.author === "system"),
    ).toBe(false);

    w.host.product.engine.stopAgent(direct.agentId);
    await w.settled(direct.conversationId, sent.replies[0]!.id);
    await until(() =>
      w
        .rows(direct.conversationId)
        .some(
          (row) =>
            row.author === "system" && row.text.includes("<captain-review>"),
        ),
    );
    const reviews = store.reviews();
    const batch = reviews.filter(
      (review) => review.id === first.id || review.id === second.id,
    );
    expect(batch).toHaveLength(2);
    expect(new Set(batch.map((review) => review.messageId)).size).toBe(1);
    expect(batch[0]!.messageId).not.toBeNull();
  });

  it("notifies the user when a Captain review run cannot complete", async () => {
    const { models } = scriptedModels(() => HANG);
    const w = await world({ ...options, models });
    const direct = await w.host.product.captain.direct();
    await w.watch(direct.conversationId);
    const review = w.host.product.captain.store.createReview({
      kind: "task_stalled",
      dedupeKey: "test:review-failure",
      body: "Review that will fail.",
    });

    await w.host.product.captain.observeReviews();
    await until(
      () =>
        w.host.product.captain.store
          .reviews()
          .find((item) => item.id === review.id)?.status === "running",
    );
    w.host.product.engine.stopAgent(direct.agentId);
    await until(() =>
      w.host.product.captain.store
        .notifications()
        .some(
          (notification) =>
            notification.kind === "review_failed" &&
            notification.data.reviewId === review.id,
        ),
    );
  });
});
