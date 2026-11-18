/**
 * Tasks wait for tasks. The graph's rules on their own (`graph.ts`: what resolves an edge, what is
 * a cycle, which base a task derives), the queue that obeys them (a run that waits for its
 * dependencies takes no slot, says whom it waits for and starts when they resolve), what a
 * cancelled dependency does (the task is blocked and its run withdrawn, until the cause is gone),
 * and the migration that brings the rows (every column of every old row survives).
 */
import type {
  BoardTaskDetail,
  BoardTaskStatus,
  MachineView,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { GraphEdge, GraphTask } from "../src/tasks/graph";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations, openDatabase } from "../src/db";
import { TaskGraph } from "../src/tasks/graph";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

/* ------------------------------------------------------------------ the graph alone */

const node = (
  number: number,
  status: BoardTaskStatus = "todo",
  extra: Partial<GraphTask> = {},
): GraphTask => ({
  id: `t${number}`,
  number,
  title: `T${number}`,
  status,
  projectId: "p",
  workspaceMode: "worktree",
  parentId: null,
  ...extra,
});

const edge = (from: number, to: number, requireDone = false): GraphEdge => ({
  taskId: `t${from}`,
  dependsOnId: `t${to}`,
  requireDone,
});

describe("the graph", () => {
  it("resolves an edge at review, or only at done when it requires it", () => {
    const at = (status: BoardTaskStatus, requireDone: boolean) =>
      new TaskGraph([node(1), node(2, status)], [edge(1, 2, requireDone)]).gate(
        "t1",
      ).state;
    expect(at("todo", false)).toBe("waiting");
    expect(at("in_progress", false)).toBe("waiting");
    expect(at("blocked", false)).toBe("waiting");
    expect(at("in_review", false)).toBe("resolved");
    expect(at("done", false)).toBe("resolved");
    expect(at("in_review", true)).toBe("waiting");
    expect(at("done", true)).toBe("resolved");
    expect(at("cancelled", false)).toBe("broken");
  });

  it("says what a task waits for, and what of it was cancelled", () => {
    const graph = new TaskGraph(
      [node(1), node(2, "done"), node(3, "in_progress"), node(4, "cancelled")],
      [edge(1, 2), edge(1, 3), edge(1, 4)],
    );
    const gate = graph.gate("t1");
    expect(gate.state).toBe("broken");
    if (gate.state !== "broken") return;
    expect(gate.cancelled.map((t) => t.number)).toEqual([4]);
    expect(gate.waitingOn.map((t) => t.number)).toEqual([3]);
    expect(new TaskGraph([node(5)], []).gate("t5")).toEqual({
      state: "resolved",
    });
  });

  it("refuses a cycle and names it", () => {
    const graph = new TaskGraph(
      [node(1), node(2), node(3)],
      [edge(1, 2), edge(2, 3)],
    );
    expect(() => graph.checkEdge("t3", "t1")).toThrow(
      /would close a cycle, #3 → #1 → #2 → #3/,
    );
    expect(() => graph.checkEdge("t2", "t1")).toThrow(/#2 → #1 → #2/);
    expect(() => graph.checkEdge("t1", "t1")).toThrow(/cannot wait for itself/);
    // Not a cycle: two tasks waiting for the same one.
    expect(() => graph.checkEdge("t1", "t3")).not.toThrow();
    // The edge that is there already is only being changed.
    expect(() => graph.checkEdge("t1", "t2")).not.toThrow();
  });

  it("refuses to wait for a cancelled task, or one that is not there", () => {
    const graph = new TaskGraph([node(1), node(2, "cancelled")], []);
    expect(() => graph.checkEdge("t1", "t2")).toThrow(/is cancelled/);
    expect(() => graph.checkEdge("t1", "t9")).toThrow(/no such task/);
  });

  it("derives a base from one dependency in the same project, at the time it is asked", () => {
    const base = (
      tasks: GraphTask[],
      edges: GraphEdge[],
    ): ReturnType<TaskGraph["derivedBase"]>["kind"] | string => {
      const derived = new TaskGraph(tasks, edges).derivedBase("t1");
      return derived.kind === "branch" ? derived.branch : derived.kind;
    };
    expect(base([node(1), node(2, "in_review")], [edge(1, 2)])).toBe(
      "eta/task-2",
    );
    // Done: its branch is usually merged and gone, so the checkout's HEAD.
    expect(base([node(1), node(2, "done")], [edge(1, 2)])).toBe("head");
    // Two dependencies, another project, a task with no worktree: nothing to derive.
    expect(base([node(1), node(2), node(3)], [edge(1, 2), edge(1, 3)])).toBe(
      "none",
    );
    expect(
      base([node(1), node(2, "todo", { projectId: "q" })], [edge(1, 2)]),
    ).toBe("none");
    expect(
      base(
        [node(1), node(2, "todo", { workspaceMode: "local" })],
        [edge(1, 2)],
      ),
    ).toBe("none");
    expect(base([node(1)], [])).toBe("none");
  });
});

/* ------------------------------------------------------------------ on a host */

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");
const numberOf = (request: Request): number =>
  Number(/task #(\d+)/.exec(request.transcript[0] ?? "")?.[1]);

/**
 * A host whose executors finish when their task's gate is opened; every task has one, opened
 * from the start unless the test holds it.
 */
async function room() {
  const held = new Map<number, ReturnType<typeof gate>>();
  const briefed: number[] = [];
  const { models } = scriptedModels(async (request) => {
    if (!isRun(request)) return say("ok");
    if (request.lastRole === "toolResult") return say("finished");
    const number = numberOf(request);
    if (!briefed.includes(number)) briefed.push(number);
    await held.get(number)?.opened;
    return call("finish_task", { summary: `#${number} done.` });
  });
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id], "plan");
  const make = (
    title: string,
    extra: {
      status?: BoardTaskStatus;
      dependsOn?: { task: string; requireDone?: boolean }[];
    } = {},
  ): BoardTaskDetail =>
    w.host.product.board.create(
      {
        title,
        description: `Do ${title}`,
        status: extra.status ?? "todo",
        conversationId: group.id,
        workspace: "local",
        dependsOn: extra.dependsOn,
      },
      { kind: "agent", agentId: ada.id },
    );
  /** Hold the executor of the task that will be made next with this number. */
  const hold = (number: number) => {
    const g = gate();
    held.set(number, g);
    return g;
  };
  return { w, ada, group, make, hold, briefed };
}

const runsOf = (w: World, taskId: string): TaskRunView[] =>
  w.host.product.board.detail(taskId)!.runs;
const lastRun = (w: World, taskId: string): TaskRunView | undefined =>
  runsOf(w, taskId).at(-1);
const taskOf = (w: World, id: string): BoardTaskDetail =>
  w.host.product.board.detail(id)!;
const settled = (w: World, id: string): boolean =>
  runsOf(w, id).every(
    (run) => !["queued", "starting", "running"].includes(run.status),
  );
const reviewed = (w: World, id: string): boolean =>
  taskOf(w, id).status === "in_review" && settled(w, id);
const primaryOf = (w: World): MachineView =>
  w.client
    .section<MachineView[]>("machines", "list")!
    .find((machine) => machine.kind === "primary")!;
const entries = (w: World, id: string, kind: string): TaskActivityView[] =>
  w.host.product.board.activity(id).filter((entry) => entry.kind === kind);

describe("the queue and dependencies", () => {
  it("holds a task's first run until what it waits for is in review, and says on whom", async () => {
    const r = await room();
    const first = r.hold(1);
    const a = r.make("A");
    const b = r.make("B", { dependsOn: [{ task: "#1" }] });
    await until(() => lastRun(r.w, a.id)?.status === "running");
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    expect(lastRun(r.w, b.id)!.status).toBe("queued");
    expect(taskOf(r.w, b.id).dependsOn).toEqual([
      expect.objectContaining({ number: 1, state: "waiting" }),
    ]);
    expect(taskOf(r.w, a.id).dependents).toEqual([
      expect.objectContaining({ number: 2, state: "waiting" }),
    ]);
    // A dependency is not a busy machine: B never took a slot.
    await until(() => r.briefed.length === 1);
    expect(r.briefed).toEqual([1]);

    first.open();
    await until(() => reviewed(r.w, b.id));
    expect(r.briefed).toEqual([1, 2]);
    expect(taskOf(r.w, b.id).dependsOn![0]!.state).toBe("resolved");
  });

  it("holds a requireDone edge through review and lets it go at done", async () => {
    const r = await room();
    const a = r.make("A");
    await until(() => reviewed(r.w, a.id));
    const b = r.make("B", { dependsOn: [{ task: a.id, requireDone: true }] });
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    await r.w.client.call("tasks", "update", { taskId: a.id, status: "done" });
    await until(() => reviewed(r.w, b.id));
  });

  it("starts a run whose dependencies are resolved ahead of an older one that still waits", async () => {
    const r = await room();
    await r.w.client.call("machines", "setMaxActiveRuns", {
      machineId: primaryOf(r.w).id,
      maxActiveRuns: 1,
    });
    const busy = r.hold(1);
    const x = r.make("X");
    await until(() => lastRun(r.w, x.id)?.status === "running");
    // #2 is in the backlog: #3 waits for it, older in the queue than #4, which waits for nothing.
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { dependsOn: [{ task: a.id }] });
    const c = r.make("C");
    await until(
      () =>
        lastRun(r.w, b.id)?.queueReason === "waiting_deps" &&
        lastRun(r.w, c.id)?.queueReason === "machine_full",
    );
    busy.open();
    await until(() => reviewed(r.w, c.id));
    expect(r.briefed).toEqual([1, 4]);
    expect(lastRun(r.w, b.id)).toMatchObject({
      status: "queued",
      queueReason: "waiting_deps",
    });
  });

  it("does not hold a run woken by a comment", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B");
    await until(() => reviewed(r.w, b.id));
    await r.w.client.call("tasks", "addDependency", {
      taskId: b.id,
      dependsOn: "#1",
    });
    await r.w.client.call("tasks", "comment", {
      taskId: b.id,
      body: "One more thing.",
    });
    await until(() => runsOf(r.w, b.id).length === 2 && reviewed(r.w, b.id));
    // A rerun starts the work again, so it waits.
    await r.w.client.call("tasks", "rerun", { taskId: b.id });
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    expect(taskOf(r.w, a.id).status).toBe("backlog");
  });

  it("refuses an edge that closes a cycle, saying which", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { status: "backlog", dependsOn: [{ task: "#1" }] });
    const c = r.make("C", { status: "backlog", dependsOn: [{ task: "#2" }] });
    await expect(
      r.w.client.call("tasks", "addDependency", {
        taskId: a.id,
        dependsOn: c.id,
      }),
    ).rejects.toThrow(/#1 → #3 → #2 → #1/);
    expect(taskOf(r.w, a.id).dependsOn).toEqual([]);
    expect(() => r.make("D", { dependsOn: [{ task: "#99" }] })).toThrow(
      /no such task/,
    );
    // Nothing of the refused task is left behind.
    expect(r.w.host.product.board.list().map((t) => t.number)).toEqual(
      expect.not.arrayContaining([4]),
    );
    expect(taskOf(r.w, b.id).dependents![0]!.number).toBe(3);
  });

  it("changes requireDone on an edge that is there, and removes one", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { status: "backlog", dependsOn: [{ task: a.id }] });
    await r.w.client.call("tasks", "addDependency", {
      taskId: b.id,
      dependsOn: a.id,
      requireDone: true,
    });
    expect(taskOf(r.w, b.id).dependsOn![0]!.requireDone).toBe(true);
    await r.w.client.call("tasks", "removeDependency", {
      taskId: b.id,
      dependsOn: "#1",
    });
    expect(taskOf(r.w, b.id).dependsOn).toEqual([]);
    expect(entries(r.w, b.id, "dependency").map((e) => e.data.action)).toEqual([
      "added",
      "required",
      "removed",
    ]);
  });
});

describe("a cancelled dependency", () => {
  it("blocks the task, withdraws its run, and lets it go when the dependency is removed", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { dependsOn: [{ task: a.id }] });
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    await r.w.client.call("tasks", "update", {
      taskId: a.id,
      status: "cancelled",
    });
    await until(() => taskOf(r.w, b.id).status === "blocked");
    // The run that would have started the work is withdrawn; the `blocked` entry says why.
    expect(lastRun(r.w, b.id)).toMatchObject({
      status: "interrupted",
      error: null,
    });
    const blocked = entries(r.w, b.id, "dependency").at(-1)!;
    expect(blocked.data).toMatchObject({ action: "blocked", number: 1 });
    // The host writes only what happened; each reader says it in its own language.
    expect(blocked.body).toBeNull();
    expect(entries(r.w, b.id, "status").at(-1)!.data).toMatchObject({
      to: "blocked",
      reason: "dependency_cancelled",
    });
    expect(taskOf(r.w, b.id).dependsOn![0]!.state).toBe("cancelled");

    await r.w.client.call("tasks", "removeDependency", {
      taskId: b.id,
      dependsOn: a.id,
    });
    await until(() => reviewed(r.w, b.id));
    expect(r.briefed).toEqual([2]);
  });

  it("lets it go back to waiting when the dependency is restored", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { dependsOn: [{ task: a.id }] });
    await r.w.client.call("tasks", "update", {
      taskId: a.id,
      status: "cancelled",
    });
    await until(() => taskOf(r.w, b.id).status === "blocked");
    await r.w.client.call("tasks", "update", { taskId: a.id, status: "todo" });
    await until(() => taskOf(r.w, b.id).status === "todo");
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    await until(() => reviewed(r.w, a.id));
    await until(() => reviewed(r.w, b.id));
  });

  it("never undoes a block someone else made", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { status: "backlog", dependsOn: [{ task: a.id }] });
    await r.w.client.call("tasks", "update", {
      taskId: b.id,
      status: "blocked",
    });
    await r.w.client.call("tasks", "update", {
      taskId: a.id,
      status: "cancelled",
    });
    await r.w.client.call("tasks", "removeDependency", {
      taskId: b.id,
      dependsOn: a.id,
    });
    expect(taskOf(r.w, b.id).status).toBe("blocked");
    // Out of the backlog it asked for a run, which the cancelled dependency withdrew; nothing
    // asks for another, since the block is the user's.
    expect(runsOf(r.w, b.id).map((run) => run.status)).toEqual(["interrupted"]);
  });

  it("is refused as a new dependency", async () => {
    const r = await room();
    const a = r.make("A", { status: "cancelled" });
    expect(() => r.make("B", { dependsOn: [{ task: a.id }] })).toThrow(
      /is cancelled/,
    );
  });
});

describe("a deleted dependency", () => {
  it("goes with its edges, says so on what waited for it, and lets that start", async () => {
    const r = await room();
    const a = r.make("A", { status: "backlog" });
    const b = r.make("B", { dependsOn: [{ task: a.id }] });
    await until(() => lastRun(r.w, b.id)?.queueReason === "waiting_deps");
    await r.w.client.call("tasks", "delete", { taskId: a.id });
    await until(() => reviewed(r.w, b.id));
    expect(entries(r.w, b.id, "dependency").at(-1)).toMatchObject({
      data: { action: "deleted", number: 1 },
    });
    expect(
      r.w.host.db.query("SELECT COUNT(*) AS n FROM task_dependency").get(),
    ).toEqual({ n: 0 });
  });
});

/* ------------------------------------------------------------------ the migration */

describe("the migration", () => {
  const dbs: ReturnType<typeof openDatabase>[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it("keeps every column of every old run and activity row, and old tasks wait for nothing", () => {
    const db = openDatabase(":memory:");
    dbs.push(db);
    const all = loadMigrations();
    const at = all.findIndex((m) => m.id === "0051-task-dependencies");
    expect(at).toBeGreaterThan(0);
    applyMigrations(db, all.slice(0, at));
    db.exec(
      `INSERT INTO task (id, title, status, created_at, updated_at) VALUES ('t', 'Old', 'in_review', 1, 1)`,
    );
    db.exec(`INSERT INTO task_run (id, task_id, machine_id, status, queue_reason, session_id, workspace,
        nudged, error, created_at, started_at, finished_at, continues_run_id, session_key, agent_id,
        last_event_at, error_code, retryable)
      VALUES ('r1', 't', 'm', 'completed', NULL, 's1', '/w', 1, NULL, 10, 11, 12, NULL, 'task:t', NULL, 12, NULL, NULL),
             ('r2', 't', 'm', 'failed', NULL, 's1', '/w', 0, 'boom', 20, 21, 22, 'r1', 'task:t', 'agent-b', 22, 'rate_limit', 1),
             ('r3', 't', 'm', 'queued', 'machine_full', NULL, NULL, 0, NULL, 30, NULL, NULL, 'r2', NULL, NULL, 30, NULL, NULL)`);
    db.exec(`INSERT INTO task_activity (id, task_id, run_id, kind, actor, actor_agent, body, data, created_at)
      VALUES ('a1', 't', NULL, 'created', 'user', NULL, NULL, '{"status":"todo"}', 1),
             ('a2', 't', 'r2', 'run_failed', 'system', NULL, 'boom', '{}', 22),
             ('a3', 't', NULL, 'comment', 'agent', 'agent-b', 'hi', '{"clientId":"c"}', 23)`);
    const runs = db.query("SELECT * FROM task_run ORDER BY rowid").all();
    const activity = db
      .query("SELECT * FROM task_activity ORDER BY rowid")
      .all();

    applyMigrations(db, all.slice(at, at + 1));

    expect(
      db
        .query("SELECT * FROM task_run ORDER BY rowid")
        .all()
        .map((row) => {
          const { waits_for_deps, ...rest } = row as Record<string, unknown>;
          expect(waits_for_deps).toBe(0);
          return rest;
        }),
    ).toEqual(runs);
    expect(
      db.query("SELECT * FROM task_activity ORDER BY rowid").all(),
    ).toEqual(activity);
    // The run a run continues is still the table's own: deleting it clears the reference.
    db.exec("DELETE FROM task_run WHERE id = 'r1'");
    expect(
      db.query("SELECT continues_run_id FROM task_run WHERE id = 'r2'").get(),
    ).toEqual({ continues_run_id: null });
    // The indexes came back, and the new reason and kinds are accepted.
    const indexes = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('task_run', 'task_activity') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual([
      "task_activity_task",
      "task_run_open",
      "task_run_session",
      "task_run_task",
    ]);
    db.exec(
      "UPDATE task_run SET queue_reason = 'waiting_deps' WHERE id = 'r3'",
    );
    db.exec(
      `INSERT INTO task_activity (id, task_id, kind, actor, data, created_at) VALUES ('a4', 't', 'dependency', 'system', '{}', 2)`,
    );
    expect(db.query("SELECT COUNT(*) AS n FROM task_dependency").get()).toEqual(
      { n: 0 },
    );
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the derived base */

describe("the base of a task that builds on one other", () => {
  it("starts from that task's branch while it is open, and from HEAD once it is done", async () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
        { cwd, encoding: "utf8" },
      ).trim();
    const dir = await tempDir("eta-repo-");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");

    const { models } = scriptedModels((request) =>
      !isRun(request)
        ? say("ok")
        : request.lastRole === "toolResult"
          ? say("finished")
          : call("finish_task", { summary: "ok" }),
    );
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project({ path: dir });
    const group = await w.group(project.id, [ada.id], "plan");
    const make = (title: string, dependsOn?: { task: string }[]) =>
      w.host.product.board.create(
        {
          title,
          description: title,
          status: "todo",
          conversationId: group.id,
          workspace: "worktree",
          dependsOn,
        },
        { kind: "agent", agentId: ada.id },
      );
    const a = make("A");
    await until(() => reviewed(w, a.id));
    const path = taskOf(w, a.id).workspace.path!;
    writeFileSync(join(path, "from-a.txt"), "a");
    git(path, "add", ".");
    git(path, "commit", "-q", "-m", "a's work");

    const b = make("B", [{ task: a.id }]);
    expect(taskOf(w, b.id).workspace.base).toBe("eta/task-1");
    await until(() => reviewed(w, b.id));
    expect(
      existsSync(join(taskOf(w, b.id).workspace.path!, "from-a.txt")),
    ).toBe(true);

    // Done, and its branch merged away: the next one starts from the checkout's HEAD.
    await w.client.call("tasks", "update", { taskId: a.id, status: "done" });
    const c = make("C", [{ task: a.id }]);
    expect(taskOf(w, c.id).workspace.base).toBeNull();
    await until(() => reviewed(w, c.id));
    expect(
      existsSync(join(taskOf(w, c.id).workspace.path!, "from-a.txt")),
    ).toBe(false);
  });
});
