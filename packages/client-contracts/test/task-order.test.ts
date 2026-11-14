import type { BoardTaskStatus, TaskRunStatus } from "../src/index";
import { describe, expect, it } from "vitest";
import { compareTaskRuns, runningFirst, taskRunRank } from "../src/index";

interface Row {
  id: string;
  status: BoardTaskStatus;
  runStatus: TaskRunStatus | null;
  updatedAt: number;
}

const row = (
  id: string,
  status: BoardTaskStatus,
  runStatus: TaskRunStatus | null,
  updatedAt: number,
): Row => ({ id, status, runStatus, updatedAt });

const newestFirst = (rows: Row[]) =>
  [...rows].sort((a, b) => b.updatedAt - a.updatedAt);
const ids = (rows: Row[]) => rows.map((each) => each.id);

describe("taskRunRank", () => {
  it("puts a run that starts or runs first, a queued one next, the rest last", () => {
    expect(taskRunRank("running")).toBe(0);
    expect(taskRunRank("starting")).toBe(0);
    expect(taskRunRank("queued")).toBe(1);
    for (const over of [null, "completed", "failed", "interrupted"] as const)
      expect(taskRunRank(over)).toBe(2);
  });

  it("compares two tasks by it alone", () => {
    const running = row("a", "in_progress", "running", 1);
    const queued = row("b", "in_progress", "queued", 2);
    expect(compareTaskRuns(running, queued)).toBeLessThan(0);
    expect(compareTaskRuns(queued, running)).toBeGreaterThan(0);
    expect(compareTaskRuns(queued, queued)).toBe(0);
  });
});

describe("runningFirst", () => {
  it("puts a running task before a queued one of the same status, even one updated later", () => {
    const list = newestFirst([
      row("running", "in_progress", "running", 100),
      row("queued", "in_progress", "queued", 200),
    ]);
    expect(ids(list)).toEqual(["queued", "running"]);
    expect(ids(runningFirst(list))).toEqual(["running", "queued"]);
  });

  it("orders running, then queued, then the rest, each in the list's own order", () => {
    const list = newestFirst([
      row("idle-new", "in_progress", null, 600),
      row("queued-new", "in_progress", "queued", 500),
      row("done-run", "in_progress", "completed", 400),
      row("running-old", "in_progress", "starting", 300),
      row("queued-old", "in_progress", "queued", 200),
      row("running-older", "in_progress", "running", 100),
    ]);
    expect(ids(runningFirst(list))).toEqual([
      "running-old",
      "running-older",
      "queued-new",
      "queued-old",
      "idle-new",
      "done-run",
    ]);
  });

  it("leaves the order between statuses as the list had it", () => {
    // A list ordered by time alone, statuses interleaved.
    const list = newestFirst([
      row("p-queued", "in_progress", "queued", 500),
      row("r-queued", "in_review", "queued", 400),
      row("p-idle", "in_progress", null, 300),
      row("r-running", "in_review", "running", 200),
      row("p-running", "in_progress", "running", 100),
    ]);
    const ordered = runningFirst(list);
    expect(ordered.map((each) => each.status)).toEqual(
      list.map((each) => each.status),
    );
    expect(ids(ordered)).toEqual([
      "p-running",
      "r-running",
      "p-queued",
      "r-queued",
      "p-idle",
    ]);
  });

  it("keeps a grouped list's groups and only reorders inside them", () => {
    const order: BoardTaskStatus[] = ["in_progress", "todo", "in_review"];
    const grouped = [
      ...newestFirst([
        row("t-queued", "todo", "queued", 900),
        row("t-running", "todo", "running", 10),
        row("p-queued", "in_progress", "queued", 800),
        row("p-running", "in_progress", "running", 20),
        row("v", "in_review", null, 700),
      ]),
    ].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    expect(ids(runningFirst(grouped))).toEqual([
      "p-running",
      "p-queued",
      "t-running",
      "t-queued",
      "v",
    ]);
  });

  it("leaves items that are not tasks where they are", () => {
    type Item = { kind: "question"; id: string } | { kind: "task"; task: Row };
    const items: Item[] = [
      { kind: "question", id: "q1" },
      { kind: "task", task: row("queued", "blocked", "queued", 1) },
      { kind: "question", id: "q2" },
      { kind: "task", task: row("running", "blocked", "running", 2) },
    ];
    const ordered = runningFirst(items, (item) =>
      item.kind === "task" ? item.task : undefined,
    );
    expect(
      ordered.map((item) => (item.kind === "task" ? item.task.id : item.id)),
    ).toEqual(["q1", "running", "q2", "queued"]);
  });

  it("does not change the list it was given", () => {
    const list = [
      row("queued", "in_progress", "queued", 2),
      row("running", "in_progress", "running", 1),
    ];
    runningFirst(list);
    expect(ids(list)).toEqual(["queued", "running"]);
  });
});
