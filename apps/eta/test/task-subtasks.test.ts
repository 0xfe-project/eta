/**
 * Tasks have subtasks. The tree's rules on their own (`graph.ts`: a parent's status from its
 * subtasks, what a subtask inherits, waiting for a parent as waiting for its subtasks, the cycles
 * that makes), and on a host: a parent does not run, moves with its subtasks, cancels with them,
 * and an executor can split its own task.
 */
import type {
  BoardTaskDetail,
  BoardTaskStatus,
  TaskRunView,
} from "@eta/client-contracts";
import type { GraphEdge, GraphTask } from "../src/tasks/graph";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import { TaskGraph } from "../src/tasks/graph";
import { until } from "./support/client";
import { tempDir } from "./support/host";
import { call, gate, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const node = (
  number: number,
  status: BoardTaskStatus = "todo",
  parent: number | null = null,
): GraphTask => ({
  id: `t${number}`,
  number,
  title: `T${number}`,
  status,
  projectId: "p",
  workspaceMode: "worktree",
  parentId: parent === null ? null : `t${parent}`,
});
const edge = (from: number, to: number, requireDone = false): GraphEdge => ({
  taskId: `t${from}`,
  dependsOnId: `t${to}`,
  requireDone,
});

describe("a parent's status", () => {
  const derived = (...children: BoardTaskStatus[]) =>
    new TaskGraph(
      [node(1), ...children.map((status, i) => node(i + 2, status, 1))],
      [],
    ).derive("t1");

  it("follows its subtasks", () => {
    expect(derived("in_progress", "todo")?.status).toBe("in_progress");
    expect(derived("in_review", "done")?.status).toBe("in_review");
    expect(derived("done", "done")?.status).toBe("done");
    expect(derived("todo", "todo")?.status).toBe("todo");
    expect(derived("backlog", "backlog")?.status).toBe("backlog");
    // Part of the work is done and the rest has not started: the stage is under way.
    expect(derived("done", "todo")?.status).toBe("in_progress");
    expect(derived("blocked", "todo")?.status).toBe("blocked");
    expect(derived("blocked", "in_progress")?.status).toBe("in_progress");
    expect(new TaskGraph([node(1)], []).derive("t1")).toBeUndefined();
  });

  it("does not count cancelled subtasks, and is blocked when every one is", () => {
    expect(derived("cancelled", "done", "done")?.status).toBe("done");
    expect(derived("cancelled", "in_review")?.status).toBe("in_review");
    expect(derived("cancelled", "cancelled")).toEqual({
      status: "blocked",
      reason: "all_cancelled",
    });
  });
});

describe("the tree and the edges", () => {
  it("makes a subtask wait for what its parents wait for", () => {
    const graph = new TaskGraph(
      [node(1), node(2), node(3, "todo", 2), node(4, "todo", 3)],
      [edge(2, 1), edge(3, 1)],
    );
    const gate = graph.gate("t4");
    expect(gate.state).toBe("waiting");
    expect(graph.heldBy("t4")).toEqual([
      expect.objectContaining({ dependsOnId: "t1", inherited: true }),
    ]);
  });

  it("refuses a subtask waiting for its own parent, and a parent waiting for its subtask", () => {
    const graph = new TaskGraph([node(1), node(2, "todo", 1)], []);
    expect(() => graph.checkEdge("t2", "t1")).toThrow(
      /#2 "T2" cannot wait for #1 "T1": it is part of it/,
    );
    expect(() => graph.checkEdge("t1", "t2")).toThrow(
      /its own subtask: a subtask waits for what its parents wait for/,
    );
  });

  it("counts waiting for a parent as waiting for its subtasks, the later ones too", () => {
    // #3 waits for stage #1; #2 is in the stage. #2 waiting for #3 is a cycle.
    const graph = new TaskGraph(
      [node(1), node(2, "todo", 1), node(3)],
      [edge(3, 1)],
    );
    expect(() => graph.checkEdge("t2", "t3")).toThrow(/#2 → #3 → #2/);
    // And a task that waits for #3 cannot be put into the stage #3 waits for.
    const later = new TaskGraph(
      [node(1), node(2, "todo", 1), node(3), node(4)],
      [edge(3, 1), edge(4, 3)],
    );
    expect(() => later.checkParent("t4", "t1")).toThrow(/cycle/);
    // Nor under #3 itself: waiting for #3 would be waiting for itself.
    expect(() => later.checkParent("t4", "t3")).toThrow(/#4 → #4/);
  });

  it("refuses a task as its own ancestor", () => {
    const graph = new TaskGraph(
      [node(1), node(2, "todo", 1), node(3, "todo", 2)],
      [],
    );
    expect(() => graph.checkParent("t1", "t3")).toThrow(/its own ancestor/);
    expect(() => graph.checkParent("t1", "t1")).toThrow(/its own ancestor/);
    expect(graph.ancestorsOf("t3").map((t) => t.number)).toEqual([2, 1]);
    expect(graph.descendantsOf("t1").map((t) => t.number)).toEqual([2, 3]);
  });

  it("derives no base from a parent, or for one", () => {
    const graph = new TaskGraph(
      [node(1), node(2, "todo", 1), node(3), node(4)],
      [edge(3, 1), edge(1, 4)],
    );
    expect(graph.derivedBase("t3").kind).toBe("none");
    expect(graph.derivedBase("t1").kind).toBe("none");
  });
});

/* ------------------------------------------------------------------ on a host */

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");
const numberOf = (request: Request): number =>
  Number(/task #(\d+)/.exec(request.transcript[0] ?? "")?.[1]);

async function room(
  split?: (request: Request) => ReturnType<typeof call> | undefined,
  options: { dataDir?: string } = {},
) {
  const held = new Map<number, ReturnType<typeof gate>>();
  const briefed: number[] = [];
  const { models } = scriptedModels(async (request) => {
    if (!isRun(request)) return say("ok");
    const number = numberOf(request);
    if (!briefed.includes(number)) briefed.push(number);
    const step = split?.(request);
    if (step !== undefined) return step;
    if (request.lastRole === "toolResult") return say("finished");
    await held.get(number)?.opened;
    return call("finish_task", { summary: `#${number} done.` });
  });
  const w = await world({ models, ...options });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const bo = await w.agent("Bo");
  const group = await w.group(project.id, [ada.id, bo.id], "plan");
  const make = (
    title: string,
    extra: {
      status?: BoardTaskStatus;
      parent?: string;
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
        parent: extra.parent,
      },
      { kind: "agent", agentId: ada.id },
    );
  const hold = (number: number) => {
    const g = gate();
    held.set(number, g);
    return g;
  };
  return { w, make, hold, briefed, bo, models };
}

const taskOf = (w: World, id: string): BoardTaskDetail =>
  w.host.product.board.detail(id)!;
const runsOf = (w: World, id: string): TaskRunView[] => taskOf(w, id).runs;
const settled = (w: World, id: string): boolean =>
  runsOf(w, id).every(
    (run) => !["queued", "starting", "running"].includes(run.status),
  );
const statusOf = (w: World, id: string) => taskOf(w, id).status;

describe("a parent on the board", () => {
  it("does not run, and moves with its subtasks to done", async () => {
    const r = await room();
    const one = r.hold(2);
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id });
    const b = r.make("B", { parent: stage.id, dependsOn: [{ task: a.id }] });
    await until(() => statusOf(r.w, a.id) === "in_progress");
    expect(statusOf(r.w, stage.id)).toBe("in_progress");
    expect(taskOf(r.w, stage.id).subtasks).toEqual({ total: 2, done: 0 });
    expect(taskOf(r.w, stage.id).children!.map((c) => c.number)).toEqual([
      2, 3,
    ]);
    expect(taskOf(r.w, b.id).ancestors!.map((c) => c.number)).toEqual([1]);
    one.open();
    await until(
      () => statusOf(r.w, b.id) === "in_review" && settled(r.w, b.id),
    );
    expect(statusOf(r.w, stage.id)).toBe("in_review");
    // The parent never ran.
    expect(runsOf(r.w, stage.id)).toEqual([]);
    expect(r.briefed).toEqual([2, 3]);

    for (const id of [a.id, b.id])
      await r.w.client.call("tasks", "update", { taskId: id, status: "done" });
    expect(statusOf(r.w, stage.id)).toBe("done");
    const reasons = r.w.host.product.board
      .activity(stage.id)
      .filter((e) => e.kind === "status")
      .map((e) => [e.data.to, e.data.reason]);
    expect(reasons).toEqual([
      ["todo", "subtasks"],
      ["in_progress", "subtasks"],
      ["in_review", "subtasks"],
      ["done", "subtasks"],
    ]);
  });

  it("refuses a status of its own, and cancels with all of its open subtasks", async () => {
    const r = await room();
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id, status: "backlog" });
    const b = r.make("B", { parent: stage.id, status: "backlog" });
    await expect(
      r.w.client.call("tasks", "update", { taskId: stage.id, status: "done" }),
    ).rejects.toThrow(/takes its status from its subtasks \(#2, #3\)/);
    await r.w.client.call("tasks", "update", {
      taskId: stage.id,
      status: "cancelled",
    });
    expect([a.id, b.id, stage.id].map((id) => statusOf(r.w, id))).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("is blocked when its subtasks are all cancelled one by one, saying why", async () => {
    const r = await room();
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id, status: "backlog" });
    const b = r.make("B", { parent: stage.id, status: "backlog" });
    await r.w.client.call("tasks", "update", { taskId: a.id, status: "done" });
    await r.w.client.call("tasks", "update", {
      taskId: b.id,
      status: "cancelled",
    });
    // One cancelled and the rest done: done.
    expect(statusOf(r.w, stage.id)).toBe("done");
    const second = r.make("C", { status: "backlog" });
    const c = r.make("C1", { parent: second.id, status: "backlog" });
    await r.w.client.call("tasks", "update", {
      taskId: c.id,
      status: "cancelled",
    });
    expect(statusOf(r.w, second.id)).toBe("blocked");
    // The host writes only what happened; each reader says it in its own language.
    expect(
      r.w.host.product.board
        .activity(second.id)
        .find((e) => e.data.action === "all_cancelled"),
    ).toMatchObject({ kind: "subtask", body: null });
  });

  it("holds the work of a stage that waits for another stage, the subtasks added later too", async () => {
    const r = await room();
    const firstGate = r.hold(2);
    const one = r.make("Stage 1", { status: "backlog" });
    const a = r.make("A", { parent: one.id });
    const two = r.make("Stage 2", {
      status: "backlog",
      dependsOn: [{ task: one.id }],
    });
    const b = r.make("B", { parent: two.id });
    await until(() => runsOf(r.w, b.id)[0]?.queueReason === "waiting_deps");
    expect(taskOf(r.w, b.id).waitingOn).toEqual([
      expect.objectContaining({ number: 1, state: "waiting", via: 3 }),
    ]);
    // A subtask added to stage 1 now is one more thing stage 2 waits for.
    const late = r.make("A2", { parent: one.id, status: "backlog" });
    firstGate.open();
    await until(
      () => statusOf(r.w, a.id) === "in_review" && settled(r.w, a.id),
    );
    expect(statusOf(r.w, one.id)).toBe("in_progress");
    expect(runsOf(r.w, b.id)[0]!.status).toBe("queued");
    await r.w.client.call("tasks", "update", {
      taskId: late.id,
      status: "todo",
    });
    await until(
      () => statusOf(r.w, b.id) === "in_review" && settled(r.w, b.id),
    );
    expect(statusOf(r.w, two.id)).toBe("in_review");
  });

  it("is not woken by a comment, nor rerun: it does not run itself", async () => {
    const r = await room();
    const busy = r.hold(2);
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id });
    await until(() => statusOf(r.w, stage.id) === "in_progress");
    await r.w.client.call("tasks", "comment", {
      taskId: stage.id,
      body: "How is this stage going?",
    });
    await expect(
      r.w.client.call("tasks", "rerun", { taskId: stage.id }),
    ).rejects.toThrow(/has subtasks: it does not run itself/);
    busy.open();
    await until(
      () => statusOf(r.w, a.id) === "in_review" && settled(r.w, a.id),
    );
    expect(runsOf(r.w, stage.id)).toEqual([]);
    expect(r.briefed).toEqual([2]);
    // The comment is on its timeline, read by whoever looks.
    expect(
      r.w.host.product.board
        .activity(stage.id)
        .some((e) => e.kind === "comment"),
    ).toBe(true);
  });

  it("still has its thread: an agent mentioned on it answers in a run of its own", async () => {
    const r = await room();
    const busy = r.hold(2);
    const stage = r.make("Stage", { status: "backlog" });
    r.make("A", { parent: stage.id });
    await until(() => statusOf(r.w, stage.id) === "in_progress");
    await r.w.client.call("tasks", "comment", {
      taskId: stage.id,
      body: "Bo, what do you make of this stage?",
      mentions: [r.bo.id],
    });
    await until(() =>
      runsOf(r.w, stage.id).some(
        (run) => run.agentId === r.bo.id && run.status === "completed",
      ),
    );
    // Bo's lane ran and answered; the executor's lane did not.
    expect(runsOf(r.w, stage.id).map((run) => run.agentId)).toEqual([r.bo.id]);
    expect(
      r.w.host.product.board
        .activity(stage.id)
        .some((e) => e.kind === "comment" && e.actor.agentId === r.bo.id),
    ).toBe(true);
    busy.open();
  });

  it("withdraws a comment's run that waited when the task got subtasks", async () => {
    const r = await room();
    const task = r.make("Task");
    await until(
      () => statusOf(r.w, task.id) === "in_review" && settled(r.w, task.id),
    );
    await r.w.client.call("machines", "setMaxActiveRuns", {
      machineId: r.w.host.db
        .query<{ id: string }, []>(
          "SELECT id FROM machine WHERE kind = 'primary'",
        )
        .get()!.id,
      maxActiveRuns: 1,
    });
    const busy = r.hold(2);
    const other = r.make("Other");
    await until(() => runsOf(r.w, other.id)[0]?.status === "running");
    // A comment wakes #1, and the run waits for the machine's one slot.
    await r.w.client.call("tasks", "comment", {
      taskId: task.id,
      body: "Also this.",
    });
    await until(
      () => runsOf(r.w, task.id).at(-1)?.queueReason === "machine_full",
    );
    r.make("Part", { parent: task.id, status: "backlog" });
    expect(runsOf(r.w, task.id).at(-1)).toMatchObject({
      status: "interrupted",
    });
    busy.open();
    await until(() => settled(r.w, other.id));
    expect(runsOf(r.w, task.id).map((run) => run.status)).toEqual([
      "completed",
      "interrupted",
    ]);
  });

  it("moves a task under a parent and out again, and says so on both", async () => {
    const r = await room();
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { status: "backlog" });
    await r.w.client.call("tasks", "setParent", {
      taskId: a.id,
      parent: `#${stage.number}`,
    });
    expect(taskOf(r.w, a.id).parentId).toBe(stage.id);
    expect(statusOf(r.w, stage.id)).toBe("backlog");
    await r.w.client.call("tasks", "setParent", { taskId: a.id, parent: null });
    expect(taskOf(r.w, a.id).parentId).toBeNull();
    const kinds = (id: string) =>
      r.w.host.product.board
        .activity(id)
        .filter((e) => e.kind === "parent" || e.kind === "subtask")
        .map(
          (e) =>
            `${e.kind}:${String(e.data.action ?? (e.data.to === null ? "out" : "in"))}`,
        );
    expect(kinds(a.id)).toEqual(["parent:in", "parent:out"]);
    expect(kinds(stage.id)).toEqual(["subtask:added", "subtask:removed"]);
    await expect(
      r.w.client.call("tasks", "setParent", {
        taskId: stage.id,
        parent: stage.id,
      }),
    ).rejects.toThrow(/its own ancestor/);
  });

  it("leaves the subtasks of a deleted parent on the board", async () => {
    const r = await room();
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id, status: "backlog" });
    await r.w.client.call("tasks", "delete", { taskId: stage.id });
    expect(taskOf(r.w, a.id).parentId).toBeNull();
    expect(r.w.host.product.board.activity(a.id).at(-1)).toMatchObject({
      kind: "parent",
      data: { to: null },
    });
  });
});

describe("a parent's stored status", () => {
  const USER = { kind: "user", agentId: null } as const;

  it("moves in the same write as its subtask: when the parent's write fails, neither moves", async () => {
    const r = await room();
    const board = r.w.host.product.board;
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id, status: "backlog" });
    r.make("B", { parent: stage.id, status: "backlog" });
    // The parent's write fails, the way a process dying between the two writes would leave it.
    r.w.host.db.exec(
      `CREATE TRIGGER crash BEFORE UPDATE OF status ON task WHEN NEW.id = '${stage.id}'
       BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`,
    );
    expect(() => board.update(a.id, { status: "done" }, USER)).toThrow(
      /simulated crash/,
    );
    // Nothing of it stayed: the subtask did not move without its parent.
    expect(statusOf(r.w, a.id)).toBe("backlog");
    expect(statusOf(r.w, stage.id)).toBe(
      board.graph().derive(stage.id)!.status,
    );
    r.w.host.db.exec("DROP TRIGGER crash");
    board.update(a.id, { status: "done" }, USER);
    expect(statusOf(r.w, a.id)).toBe("done");
    expect(statusOf(r.w, stage.id)).toBe("in_progress");
  });

  it("is made again from its subtasks as the host starts, and what waits for it goes on", async () => {
    const dataDir = await tempDir();
    const r = await room(undefined, { dataDir });
    const board = r.w.host.product.board;
    const stage = r.make("Stage", { status: "backlog" });
    const a = r.make("A", { parent: stage.id, status: "backlog" });
    const b = r.make("B", { parent: stage.id, status: "backlog" });
    for (const id of [a.id, b.id]) board.update(id, { status: "done" }, USER);
    expect(statusOf(r.w, stage.id)).toBe("done");
    // The stored copy is wrong, as a write that never landed would leave it, and a task waits on it.
    r.w.host.db
      .query("UPDATE task SET status = 'in_progress' WHERE id = ?")
      .run(stage.id);
    const next = r.make("Next", {
      dependsOn: [{ task: stage.id, requireDone: true }],
    });
    await until(() => runsOf(r.w, next.id)[0]?.queueReason === "waiting_deps");

    // The process dies: what the next one finds is a copy of the file.
    const copy = await tempDir();
    r.w.host.db.exec(`VACUUM INTO '${copy}/eta.sqlite'`);
    const later = await world({ dataDir: copy, models: r.models });
    const after = later.host.product.board;
    expect(after.detail(stage.id)!.status).toBe("done");
    expect(after.activity(stage.id).at(-1)).toMatchObject({
      kind: "status",
      actor: { kind: "system" },
      data: { from: "in_progress", to: "done", reason: "recomputed" },
    });
    // What waited for the stage reads the corrected status, and starts.
    await until(() => after.detail(next.id)!.status === "in_review");
  });
});

describe("an executor splitting its task", () => {
  it("makes subtasks, ends its run, and the task follows them", async () => {
    let made = 0;
    const r = await room((request) => {
      if (numberOf(request) !== 1) return undefined;
      if (request.lastRole !== "toolResult")
        return call("create_subtask", {
          title: "Part A",
          description: "Do part A",
        });
      made += 1;
      if (made === 1)
        return call("create_subtask", {
          title: "Part B",
          description: "Do part B",
          dependsOn: [{ task: "#2" }],
        });
      if (made === 2)
        return call("finish_task", { summary: "Split into #2 and #3." });
      return say("split");
    });
    const big = r.make("Big");
    await until(() => {
      const t = taskOf(r.w, big.id);
      return (t.children ?? []).length === 2 && settled(r.w, big.id);
    });
    const [a, b] = taskOf(r.w, big.id).children!;
    await until(() => statusOf(r.w, b!.taskId) === "in_review");
    expect(statusOf(r.w, a!.taskId)).toBe("in_review");
    // It ended with finish_task, but the status is its subtasks'.
    expect(statusOf(r.w, big.id)).toBe("in_review");
    expect(runsOf(r.w, big.id).map((run) => run.status)).toEqual(["completed"]);
    expect(taskOf(r.w, b!.taskId).dependsOn![0]!.number).toBe(a!.number);
    expect(r.briefed).toEqual([1, 2, 3]);
  });
});
