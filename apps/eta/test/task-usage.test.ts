/**
 * What a task's runs used, in tokens, by model and by run (`tasks.usage`, and each task's `usage`
 * section). Real hosts with scripted models for eta's own loop, and the fake ACP agent as a real
 * stdio child for an external runtime; an upgraded database for the runs from before.
 *
 * What these pin: every request of a run is counted for that run (two runs of one session apart),
 * with the model that answered; the three views agree; a run whose runtime reported nothing is "no
 * data" and not 0; a parent adds in its subtasks, each run once; a client watching the task is
 * pushed the new numbers, not left to poll; and the runs from before are filled in from what is
 * left of them, or marked as having no data.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AcpAgentView,
  BoardTaskDetail,
  BoardTaskView,
  TaskUsageView,
} from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeAgent } from "@eta/runtime-acp/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { TaskUsageStore } from "../src/tasks/usage";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");

/** An answer with the tokens the provider counted for it, and who answered. */
function billed(
  message: AssistantMessage,
  bill: {
    provider: string;
    model: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
  },
): AssistantMessage {
  const input = bill.input ?? 0;
  const output = bill.output ?? 0;
  const cacheRead = bill.cacheRead ?? 0;
  const cacheWrite = bill.cacheWrite ?? 0;
  return {
    ...message,
    provider: bill.provider,
    model: bill.model,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(bill.reasoning === undefined ? {} : { reasoning: bill.reasoning }),
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const usageOf = async (
  w: World,
  taskId: string,
  includeSubtasks?: boolean,
): Promise<TaskUsageView> =>
  (
    (await w.client.call("tasks", "usage", {
      taskId,
      ...(includeSubtasks === undefined ? {} : { includeSubtasks }),
    })) as { usage: TaskUsageView }
  ).usage;

/**
 * The models a test scripted. A run's session also makes requests that are not its turns (the
 * memory read after it, on the host's own path); those are counted for the run too, and the
 * stand-in model (`fake`) answers them with no tokens, so they are "no data" and left out here.
 */
const scripted = <T extends { provider: string }>(models: T[]): T[] =>
  models.filter((model) => model.provider !== "fake");

const ended = (w: World, id: string, n: number): boolean => {
  const runs = w.host.product.board.detail(id)!.runs;
  return (
    runs.length === n &&
    runs.every((run) => !["queued", "starting", "running"].includes(run.status))
  );
};

/** A room where Ada makes tasks; `respond` answers her runs' requests. */
async function room(
  respond: (request: Request) => AssistantMessage | Promise<AssistantMessage>,
) {
  const { models } = scriptedModels((request) =>
    isRun(request) ? respond(request) : say("ok"),
  );
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id], "plan");
  const make = (
    title: string,
    extra: { parent?: string; status?: "todo" | "backlog" } = {},
  ): BoardTaskDetail =>
    w.host.product.board.create(
      {
        title,
        description: `Do ${title}`,
        status: extra.status ?? "todo",
        conversationId: group.id,
        workspace: "local",
        parent: extra.parent,
      },
      { kind: "agent", agentId: ada.id },
    );
  return { w, ada, make };
}

describe("a task's usage, on eta's own loop", () => {
  it("is every request of its runs, with the model that answered, by run, by model and in total; and it is pushed", async () => {
    // Run 1 asks model a1 for the call and b1 for the last words; run 2 (woken by a comment, in the
    // same session) asks a1 again, and b1 answers it with nothing counted.
    const r = await room((request) => {
      const second = request.transcript.join("\n").includes("one more thing");
      if (request.lastRole === "toolResult")
        return second
          ? billed(say("done again"), { provider: "beta", model: "b1" })
          : billed(say("done"), {
              provider: "beta",
              model: "b1",
              input: 200,
              output: 20,
              cacheWrite: 5,
            });
      return billed(call("finish_task", { summary: "ok" }), {
        provider: "acme",
        model: "a1",
        ...(second
          ? { input: 300, output: 30 }
          : { input: 100, output: 10, cacheRead: 50, reasoning: 4 }),
      });
    });
    const task = r.make("Count");
    r.w.client.subscribe(`tasks.${task.id}`);
    const pushed = () =>
      r.w.client.section<TaskUsageView>(`tasks.${task.id}`, "usage");
    await until(() => ended(r.w, task.id, 1));
    // The client is told, without asking: the section moved with the run.
    await until(() => pushed()?.totals.tokens?.total === 385);

    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "one more thing",
    });
    await until(() => ended(r.w, task.id, 2));
    await until(() => pushed()?.totals.tokens?.total === 715);

    const usage = await usageOf(r.w, task.id);
    const [one, two] = r.w.host.product.board.detail(task.id)!.runs;
    // Two runs of one session, each with its own requests.
    expect(two!.sessionId).toBe(one!.sessionId);
    const runs = usage.runs.map((run) => ({
      ...run,
      models: scripted(run.models),
    }));
    expect(runs).toEqual([
      {
        runId: one!.id,
        taskId: task.id,
        agentId: r.ada.id,
        mentioned: false,
        status: "completed",
        startedAt: one!.startedAt,
        finishedAt: one!.finishedAt,
        tokens: {
          input: 300,
          output: 30,
          cacheRead: 50,
          cacheWrite: 5,
          reasoning: 4,
          total: 385,
        },
        models: [
          {
            provider: "beta",
            model: "b1",
            tokens: {
              input: 200,
              output: 20,
              cacheRead: 0,
              cacheWrite: 5,
              reasoning: null,
              total: 225,
            },
          },
          {
            provider: "acme",
            model: "a1",
            tokens: {
              input: 100,
              output: 10,
              cacheRead: 50,
              cacheWrite: 0,
              reasoning: 4,
              total: 160,
            },
          },
        ],
      },
      expect.objectContaining({
        runId: two!.id,
        tokens: {
          input: 300,
          output: 30,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: null,
          total: 330,
        },
        // b1 answered, and its provider counted nothing: not 0, no data.
        models: [
          expect.objectContaining({ model: "a1" }),
          { provider: "beta", model: "b1", tokens: null },
        ],
      }),
    ]);
    expect(scripted(usage.models)).toEqual([
      {
        provider: "acme",
        model: "a1",
        tokens: {
          input: 400,
          output: 40,
          cacheRead: 50,
          cacheWrite: 0,
          reasoning: 4,
          total: 490,
        },
        runs: 2,
        runsWithoutData: 0,
      },
      {
        provider: "beta",
        model: "b1",
        tokens: {
          input: 200,
          output: 20,
          cacheRead: 0,
          cacheWrite: 5,
          reasoning: null,
          total: 225,
        },
        runs: 2,
        runsWithoutData: 1,
      },
    ]);
    expect(usage.totals).toEqual({
      tokens: {
        input: 600,
        output: 60,
        cacheRead: 50,
        cacheWrite: 5,
        reasoning: 4,
        total: 715,
      },
      runs: 2,
      runsWithoutData: 0,
    });
    await until(
      () =>
        JSON.stringify(pushed()) ===
        JSON.stringify({ ...usage, includesSubtasks: true }),
    );
  });

  it("is pushed to the task and the tasks above it as each request is counted, before the run ends", async () => {
    const second = gate();
    const r = await room(async (request) => {
      if (request.lastRole !== "toolResult")
        return billed(call("finish_task", { summary: "ok" }), {
          provider: "acme",
          model: "a1",
          input: 70,
          output: 7,
        });
      await second.opened;
      return billed(say("done"), { provider: "acme", model: "a1", input: 1 });
    });
    const stage = r.make("Stage", { status: "backlog" });
    const task = r.make("Held", { parent: stage.id });
    for (const id of [task.id, stage.id]) r.w.client.subscribe(`tasks.${id}`);
    const total = (id: string) =>
      r.w.client.section<TaskUsageView>(`tasks.${id}`, "usage")?.totals.tokens
        ?.total;
    // The first request is counted while the second is held: nothing else about the task moves.
    await until(() => total(task.id) === 77 && total(stage.id) === 77);
    expect(r.w.host.product.board.detail(task.id)!.runs[0]!.status).toBe(
      "running",
    );
    second.open();
    await until(() => ended(r.w, task.id, 1));
    await until(() => total(task.id) === 78 && total(stage.id) === 78);
  });

  it("is no data, not 0, for a run whose provider counted nothing", async () => {
    const r = await room((request) =>
      billed(
        request.lastRole === "toolResult"
          ? say("done")
          : call("finish_task", { summary: "ok" }),
        { provider: "quiet", model: "q1" },
      ),
    );
    const task = r.make("Quiet");
    await until(() => ended(r.w, task.id, 1));
    const usage = await usageOf(r.w, task.id);
    expect(usage.totals).toEqual({ tokens: null, runs: 1, runsWithoutData: 1 });
    expect(usage.runs[0]!.tokens).toBeNull();
    expect(scripted(usage.runs[0]!.models)).toEqual([
      { provider: "quiet", model: "q1", tokens: null },
    ]);
    expect(scripted(usage.models)).toEqual([
      {
        provider: "quiet",
        model: "q1",
        tokens: null,
        runs: 1,
        runsWithoutData: 1,
      },
    ]);
  });

  it("adds a parent's subtasks in when asked, each run once, and pushes the parent too", async () => {
    const r = await room((request) => {
      const number = Number(
        /task #(\d+)/.exec(request.transcript[0] ?? "")?.[1],
      );
      return billed(
        request.lastRole === "toolResult"
          ? say("done")
          : call("finish_task", { summary: "ok" }),
        {
          provider: "acme",
          model: `m${number}`,
          input: 10 * number,
          output: number,
        },
      );
    });
    const stage = r.make("Stage", { status: "backlog" });
    r.w.client.subscribe(`tasks.${stage.id}`);
    const a = r.make("A", { parent: stage.id });
    const mid = r.make("Mid", { parent: stage.id, status: "backlog" });
    const c = r.make("C", { parent: mid.id });
    for (const id of [a.id, c.id]) await until(() => ended(r.w, id, 1));

    // Its own: a parent does not run.
    const own = await usageOf(r.w, stage.id);
    expect(own).toMatchObject({
      includesSubtasks: false,
      taskIds: [stage.id],
      totals: { tokens: null, runs: 0, runsWithoutData: 0 },
      runs: [],
    });
    // With its subtasks, at any depth: #2 (two requests of 20+2) and #4 (two of 40+4).
    const all = await usageOf(r.w, stage.id, true);
    expect(new Set(all.taskIds)).toEqual(
      new Set([stage.id, a.id, mid.id, c.id]),
    );
    expect(all.totals).toEqual({
      tokens: {
        input: 120,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: null,
        total: 132,
      },
      runs: 2,
      runsWithoutData: 0,
    });
    expect(all.runs.map((run) => run.taskId)).toEqual([a.id, c.id]);
    expect(
      scripted(all.models).map((m) => [m.model, m.tokens?.total, m.runs]),
    ).toEqual([
      ["m4", 88, 1],
      ["m2", 44, 1],
    ]);
    // A subtask's own is what it ran, nothing of its siblings'; the middle one has its subtask's.
    expect((await usageOf(r.w, a.id)).totals.tokens?.total).toBe(44);
    expect((await usageOf(r.w, mid.id, true)).totals.tokens?.total).toBe(88);
    // The parent's page is pushed the sum of its tree.
    await until(
      () =>
        r.w.client.section<TaskUsageView>(`tasks.${stage.id}`, "usage")?.totals
          .tokens?.total === 132,
    );
  });

  it("is on the board in brief, a parent's with its subtasks, so a card needs no task of its own", async () => {
    const r = await room((request) => {
      const number = Number(
        /task #(\d+)/.exec(request.transcript[0] ?? "")?.[1],
      );
      return billed(
        request.lastRole === "toolResult"
          ? say("done")
          : call("finish_task", { summary: "ok" }),
        number === 3
          ? { provider: "quiet", model: "q1" }
          : {
              provider: "acme",
              model: `m${number}`,
              input: 1000 * number,
              output: number,
            },
      );
    });
    r.w.client.subscribe("tasks");
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id });
    const quiet = r.make("Quiet", { parent: stage.id });
    const idle = r.make("Idle", { status: "backlog" });
    for (const id of [a.id, quiet.id]) await until(() => ended(r.w, id, 1));

    const card = (id: string) =>
      (r.w.client.section<BoardTaskView[]>("tasks", "list") ?? []).find(
        (task) => task.id === id,
      );
    await until(() => card(quiet.id)?.usage?.runs === 1);
    // #2 ran twice on m2 (2000 in, 2 out each): its card says the total and the model.
    expect(card(a.id)?.usage).toMatchObject({
      tokens: { total: 4004 },
      model: "m2",
      models: 1,
      runs: 1,
      runsWithoutData: 0,
      liveSessionId: null,
    });
    // A run whose provider counted nothing is "no data", not 0.
    expect(card(quiet.id)?.usage).toMatchObject({
      tokens: null,
      model: null,
      runs: 1,
      runsWithoutData: 1,
    });
    // Never ran: nothing. A parent ran nothing itself; with its subtasks it is theirs together.
    expect(card(idle.id)?.usage).toBeNull();
    expect(card(idle.id)?.usageWithSubtasks).toBeUndefined();
    expect(card(stage.id)?.usage).toBeNull();
    expect(card(stage.id)?.usageWithSubtasks).toMatchObject({
      tokens: { total: 4004 },
      model: "m2",
      runs: 2,
      runsWithoutData: 1,
    });
    // `tasks.list` says the same.
    const listed = (
      (await r.w.client.call("tasks", "list", {})) as { tasks: BoardTaskView[] }
    ).tasks.find((task) => task.id === a.id);
    expect(listed?.usage?.tokens?.total).toBe(4004);
  });

  it("refuses a task that is not there", async () => {
    const r = await room(() => say("ok"));
    await expect(usageOf(r.w, "nope")).rejects.toThrow(/no task nope/);
  });
});

describe("a task's usage, on an ACP agent", () => {
  async function acpRoom() {
    const { models } = scriptedModels(() => {
      throw new Error("an eta model was asked");
    });
    const w = await world({ models });
    const fake = fakeAgent("fake");
    (await w.client.call("acp", "save", {
      agent: fake.config,
    })) as AcpAgentView;
    const ace = await w.agent("Ace", { runtime: "acp.fake" });
    const project = await w.project();
    const group = await w.group(project.id, [ace.id], "plan");
    const make = (title: string, description: string): BoardTaskDetail =>
      w.host.product.board.create(
        {
          title,
          description,
          status: "todo",
          conversationId: group.id,
          workspace: "local",
        },
        { kind: "agent", agentId: ace.id },
      );
    return { w, ace, make };
  }

  it("is what the agent answered its prompts with; and no data when it says nothing", async () => {
    const r = await acpRoom();
    const told = r.make(
      "Told",
      `Work, then say [usage:${JSON.stringify({
        totalTokens: 1_390,
        inputTokens: 1_000,
        outputTokens: 120,
        thoughtTokens: 40,
        cachedReadTokens: 200,
        cachedWriteTokens: 30,
      })}]`,
    );
    const silent = r.make("Silent", "Work, then say [usage:none]");
    await until(() => ended(r.w, told.id, 1) && ended(r.w, silent.id, 1));
    expect(r.w.host.product.board.detail(told.id)!.runs[0]!.status).toBe(
      "completed",
    );

    const usage = await usageOf(r.w, told.id);
    // Thought tokens beside the output (the total says so) are output's; `usage_update`'s context
    // size (99,999) is not a count of what was used, and is nowhere here.
    expect(usage.totals).toEqual({
      tokens: {
        input: 1_000,
        output: 160,
        cacheRead: 200,
        cacheWrite: 30,
        reasoning: 40,
        total: 1_390,
      },
      runs: 1,
      runsWithoutData: 0,
    });
    expect(usage.models).toEqual([
      expect.objectContaining({
        provider: "acp.fake",
        runs: 1,
        runsWithoutData: 0,
      }),
    ]);
    expect(usage.runs[0]).toMatchObject({
      agentId: r.ace.id,
      status: "completed",
    });

    const none = await usageOf(r.w, silent.id);
    expect(none.totals).toEqual({ tokens: null, runs: 1, runsWithoutData: 1 });
    expect(none.runs[0]!.tokens).toBeNull();
  });
});

describe("the runs from before usage was counted per run", () => {
  const open: { close: () => void }[] = [];
  afterEach(() => {
    for (const db of open.splice(0)) db.close();
  });

  it("are filled in once from the usage table or the session's journal, else have no data", async () => {
    const dir = await tempDir();
    const db = openDatabase(databasePath(join(dir, "eta.sqlite")));
    open.push(db);
    const all = loadMigrations();
    applyMigrations(
      db,
      all.filter((m) => m.id < "0057-task-usage"),
    );
    const t0 = 1_700_000_000_000;
    db.query(
      "INSERT INTO task (id, title, status, created_at, updated_at) VALUES ('t1', 'Old', 'in_review', ?, ?)",
    ).run(t0, t0);
    const run = db.query(
      `INSERT INTO task_run (id, task_id, status, session_id, created_at, started_at, finished_at, continues_run_id)
       VALUES (?, 't1', ?, ?, ?, ?, ?, ?)`,
    );
    // r1 and r2: one session on eta's own loop, r2 a continuation; r3: an external runtime's
    // session here; r4: the same with nothing but zeros; r5: on a daemon; r6: never started.
    run.run("r1", "completed", "s-eta", t0, t0 + 10, t0 + 100, null);
    run.run("r2", "completed", "s-eta", t0 + 200, t0 + 210, t0 + 300, "r1");
    run.run("r3", "completed", "s-claude", t0 + 400, t0 + 410, t0 + 500, null);
    run.run("r4", "failed", "s-zero", t0 + 600, t0 + 610, t0 + 700, null);
    run.run("r5", "completed", "s-daemon", t0 + 800, t0 + 810, t0 + 900, null);
    run.run("r6", "interrupted", null, t0 + 950, null, t0 + 960, null);
    const used = db.query(
      `INSERT INTO usage (at, session_id, provider, model, input, output, cache_read, cache_write, reasoning, total, cost, status)
       VALUES (?, 's-eta', 'acme', ?, ?, ?, ?, 0, ?, ?, 0.5, ?)`,
    );
    used.run(t0 + 20, "a1", 100, 10, 40, 3, 150, "ok");
    used.run(t0 + 50, "a1", 0, 0, 0, 0, 0, "ok");
    used.run(t0 + 220, "a2", 70, 7, 0, 0, 77, "ok");

    const journal = (session: string, messages: object[]) => {
      mkdirSync(join(dir, "sessions", session), { recursive: true });
      writeFileSync(
        join(dir, "sessions", session, "journal.jsonl"),
        `${messages
          .map((message, i) =>
            JSON.stringify({
              w: [
                {
                  kind: "entry",
                  entry: { id: `e${i}`, type: "message", message },
                },
              ],
              t: 0,
            }),
          )
          .join("\n")}\n`,
      );
    };
    const said = (at: number, input: number, output: number) => ({
      role: "assistant",
      provider: "claude",
      model: "claude-opus-5-5",
      timestamp: at,
      stopReason: "stop",
      content: [],
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    journal("s-claude", [
      { role: "user", timestamp: t0 + 411, content: "go" },
      said(t0 + 420, 0, 0),
      said(t0 + 480, 900, 60),
    ]);
    journal("s-zero", [said(t0 + 620, 0, 0), said(t0 + 650, 0, 0)]);

    applyMigrations(db, all);
    const store = new TaskUsageStore(db, {
      dataDir: dir,
      executorOf: () => "ada",
    });
    expect(store.ofTask("t1").totals.runsWithoutData).toBe(5);
    expect(await store.backfill()).toBe(6);
    // Once: a second look finds nothing left to do, and counts nothing twice.
    expect(await store.backfill()).toBe(0);

    const usage = store.ofTask("t1");
    const byRun = Object.fromEntries(usage.runs.map((r) => [r.runId, r]));
    expect(Object.keys(byRun)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(byRun.r1!.tokens).toEqual({
      input: 100,
      output: 10,
      cacheRead: 40,
      cacheWrite: 0,
      reasoning: 3,
      total: 150,
    });
    // The zeros of an answered request were nothing counted, not nothing used.
    expect(byRun.r1!.models).toEqual([
      {
        provider: "acme",
        model: "a1",
        tokens: expect.objectContaining({ total: 150 }),
      },
    ]);
    expect(byRun.r2!.tokens?.total).toBe(77);
    expect(byRun.r3!.tokens).toEqual({
      input: 900,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: null,
      total: 960,
    });
    expect(byRun.r4!.tokens).toBeNull();
    expect(byRun.r5!.tokens).toBeNull();
    expect(usage.totals).toEqual({
      tokens: {
        input: 1_070,
        output: 77,
        cacheRead: 40,
        cacheWrite: 0,
        reasoning: 3,
        total: 1_187,
      },
      runs: 5,
      runsWithoutData: 2,
    });
    expect(
      db
        .query<{ id: string; usage_counted: string | null }, []>(
          "SELECT id, usage_counted FROM task_run ORDER BY id",
        )
        .all()
        .every((row) => row.usage_counted === "backfill"),
    ).toBe(true);
  });
});
