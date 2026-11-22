/**
 * Archiving: a done or cancelled task left quiet is put away by the host (whole trees at once), any
 * task can be put away by hand (one that runs only by stopping it), anything new on an archived task
 * brings it back, and the lists leave archived tasks out while everything else counts them.
 */
import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskBoardSettings,
} from "@eta/client-contracts";
import type { Request } from "./support/models";
import type { World } from "./support/world";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  databasePath,
  loadMigrations,
  openDatabase,
} from "../src/db";
import { SettingStore } from "../src/settings/store";
import { TaskArchiver } from "../src/tasks/archiver";
import { until } from "./support/client";
import { call, HANG, say, scriptedModels } from "./support/models";
import { world } from "./support/world";

const DAY = 24 * 60 * 60 * 1000;

const isRun = (request: Request): boolean =>
  request.system.includes("In this task you are");
const numberOf = (request: Request): number =>
  Number(/task #(\d+)/.exec(request.transcript[0] ?? "")?.[1]);

async function room() {
  /** Tasks whose runs say nothing until they are stopped. */
  const hanging = new Set<number>();
  /** Hanging tasks whose model has been asked: a stop now reaches a request that is going. */
  const asked = new Set<number>();
  const { models } = scriptedModels((request) => {
    if (!isRun(request)) return say("ok");
    if (hanging.has(numberOf(request))) {
      asked.add(numberOf(request));
      return HANG;
    }
    if (request.lastRole === "toolResult") return say("finished");
    return call("finish_task", { summary: "done." });
  });
  const w = await world({ models });
  const ada = await w.agent("Ada");
  const project = await w.project();
  const group = await w.group(project.id, [ada.id], "plan");
  const board = w.host.product.board;
  const make = (
    title: string,
    extra: { status?: BoardTaskStatus; parent?: string } = {},
  ): BoardTaskDetail =>
    board.create(
      {
        title,
        status: extra.status ?? "backlog",
        conversationId: group.id,
        workspace: "local",
        parent: extra.parent,
      },
      { kind: "agent", agentId: ada.id },
    );
  const hang = (number: number) => hanging.add(number);
  /** A task made and moved to `status` by the user. */
  const finished = async (
    title: string,
    status: BoardTaskStatus = "done",
    parent?: string,
  ) => {
    const task = make(title, { parent });
    await w.client.call("tasks", "update", { taskId: task.id, status });
    return task;
  };
  return { w, board, make, hang, asked, finished };
}

const detail = (w: World, id: string) => w.host.product.board.detail(id)!;
const archived = (w: World, id: string) =>
  (detail(w, id).archivedAt ?? null) !== null;
const kinds = (w: World, id: string) =>
  w.host.product.board.activity(id).map((entry) => entry.kind);
/** The time of the task's newest timeline entry. */
const lastAt = (w: World, id: string) =>
  Math.max(...w.host.product.board.activity(id).map((e) => e.createdAt));
const settled = (w: World, id: string) =>
  detail(w, id).runs.every(
    (run) => !["queued", "starting", "running"].includes(run.status),
  );

describe("archiving on its own", () => {
  it("puts away a done or cancelled task once its timeline is quiet for longer than the days", async () => {
    const r = await room();
    const done = await r.finished("Done");
    const cancelled = await r.finished("Dropped", "cancelled");
    const review = await r.finished("Reviewed", "in_review");
    const backlog = r.make("Later");
    const last = Math.max(
      ...[done, cancelled, review, backlog].map((t) => lastAt(r.w, t.id)),
    );
    // Exactly the days is not longer than them.
    expect(r.board.archiveStale(7, lastAt(r.w, done.id) + 7 * DAY)).toEqual([]);
    const swept = r.board.archiveStale(7, last + 7 * DAY + 1);
    expect(new Set(swept)).toEqual(new Set([done.id, cancelled.id]));
    expect(archived(r.w, review.id)).toBe(false);
    expect(archived(r.w, backlog.id)).toBe(false);
    expect(detail(r.w, done.id)).toMatchObject({ archivedBy: "auto" });
    const entry = r.board.activity(done.id).at(-1)!;
    expect(entry).toMatchObject({
      kind: "archived",
      actor: { kind: "system" },
      body: null,
      data: { by: "auto", reason: "stale", days: 7 },
    });
    // Nothing more to put away: a second sweep writes nothing.
    expect(r.board.archiveStale(7, last + 8 * DAY)).toEqual([]);
  });

  it("leaves a task alone while a run of it has not ended", async () => {
    const r = await room();
    const done = await r.finished("Done");
    // A run row that is going, as a mentioned agent's answer would be.
    const db = openDatabase(databasePath(r.w.host.dataDir));
    db.query(
      `INSERT INTO task_run (id, task_id, status, created_at, started_at, agent_id)
       VALUES ('r-open', ?, 'running', ?, ?, 'someone')`,
    ).run(done.id, Date.now(), Date.now());
    const later = lastAt(r.w, done.id) + 30 * DAY;
    expect(r.board.archiveStale(7, later)).toEqual([]);
    db.query(
      "UPDATE task_run SET status = 'completed', finished_at = ? WHERE id = 'r-open'",
    ).run(Date.now());
    db.close();
    expect(r.board.archiveStale(7, later)).toEqual([done.id]);
  });

  it("puts a parent away only with its whole tree, in one sweep", async () => {
    const r = await room();
    const stage = r.make("Stage");
    const a = await r.finished("A", "done", stage.id);
    const b = r.make("B", { parent: stage.id });
    const at = () =>
      Math.max(...[stage, a, b].map((t) => lastAt(r.w, t.id))) + 8 * DAY;
    // #3 is not finished: #2 may go on its own, the stage may not.
    expect(r.board.archiveStale(7, at())).toEqual([a.id]);
    expect(archived(r.w, stage.id)).toBe(false);
    // Finishing #3 brings the stage to done, and #2's archive does not hold it back.
    await r.w.client.call("tasks", "update", { taskId: b.id, status: "done" });
    expect(detail(r.w, stage.id).status).toBe("done");
    // The parent moving wrote nothing on #2, so it stays away.
    expect(archived(r.w, a.id)).toBe(true);
    const swept = r.board.archiveStale(7, at());
    expect(new Set(swept)).toEqual(new Set([stage.id, b.id]));
    expect(r.board.activity(b.id).at(-1)!.data).toMatchObject({
      reason: "stale",
      with: { number: stage.number },
    });
  });

  it("does not put a quiet parent away while a subtask is still recent", async () => {
    const r = await room();
    const stage = r.make("Stage");
    const a = await r.finished("A", "done", stage.id);
    const stageAt = lastAt(r.w, stage.id);
    // The subtask moved much later than the parent did.
    const db = openDatabase(databasePath(r.w.host.dataDir));
    db.query(
      "UPDATE task_activity SET created_at = created_at + ? WHERE task_id = ?",
    ).run(20 * DAY, a.id);
    db.close();
    expect(r.board.archiveStale(7, stageAt + 8 * DAY)).toEqual([]);
    expect(archived(r.w, stage.id)).toBe(false);
  });
});

describe("coming back", () => {
  const away = async () => {
    const r = await room();
    const task = await r.finished("Done");
    r.board.archiveStale(7, lastAt(r.w, task.id) + 8 * DAY);
    expect(archived(r.w, task.id)).toBe(true);
    return { ...r, task };
  };

  it("comes back on a comment, saying why", async () => {
    const r = await away();
    await r.w.client.call("tasks", "comment", {
      taskId: r.task.id,
      body: "One more thing",
    });
    expect(archived(r.w, r.task.id)).toBe(false);
    expect(kinds(r.w, r.task.id).slice(-2)).toEqual(["unarchived", "comment"]);
    expect(r.board.activity(r.task.id).at(-2)).toMatchObject({
      actor: { kind: "system" },
      data: { cause: "comment" },
    });
  });

  it("comes back when its status moves off done", async () => {
    const r = await away();
    await r.w.client.call("tasks", "update", {
      taskId: r.task.id,
      status: "backlog",
    });
    expect(archived(r.w, r.task.id)).toBe(false);
    expect(r.board.activity(r.task.id).at(-2)!.data).toEqual({
      cause: "status",
    });
  });

  it("comes back when a run starts, and when it was archived by hand too", async () => {
    const r = await room();
    const task = await r.finished("Done");
    await r.w.client.call("tasks", "archive", { taskId: task.id });
    expect(detail(r.w, task.id).archivedBy).toBe("user");
    await r.w.client.call("tasks", "rerun", { taskId: task.id });
    expect(archived(r.w, task.id)).toBe(false);
    expect(
      r.board.activity(task.id).find((e) => e.kind === "unarchived"),
    ).toMatchObject({ data: { cause: "run_queued" } });
  });
});

describe("archiving by hand", () => {
  it("puts a done task away at once, and brings it back", async () => {
    const r = await room();
    const task = await r.finished("Done");
    const { task: after } = (await r.w.client.call("tasks", "archive", {
      taskId: task.id,
    })) as { task: BoardTaskDetail };
    expect(after).toMatchObject({ status: "done", archivedBy: "user" });
    expect(r.board.activity(task.id).at(-1)).toMatchObject({
      kind: "archived",
      actor: { kind: "user" },
      data: { by: "user", reason: "manual", stoppedRuns: [] },
    });
    const { tasks } = (await r.w.client.call("tasks", "unarchive", {
      taskIds: [task.id],
    })) as { tasks: BoardTaskDetail[] };
    expect(tasks[0]!.archivedAt).toBeNull();
    expect(r.board.activity(task.id).at(-1)).toMatchObject({
      kind: "unarchived",
      actor: { kind: "user" },
      data: { cause: "manual" },
    });
  });

  it("keeps an unfinished task's status, and takes its subtasks with it", async () => {
    const r = await room();
    const stage = r.make("Stage");
    const a = r.make("A", { parent: stage.id });
    await r.w.client.call("tasks", "archive", { taskId: stage.id });
    expect(detail(r.w, stage.id)).toMatchObject({ status: "backlog" });
    expect(archived(r.w, a.id)).toBe(true);
    expect(r.board.activity(a.id).at(-1)!.data).toMatchObject({
      with: { number: stage.number },
    });
    await r.w.client.call("tasks", "unarchive", { taskId: stage.id });
    expect(archived(r.w, a.id)).toBe(false);
  });

  it("stops a running task first, only when asked to, and the stopped run does not bring it back", async () => {
    const r = await room();
    r.hang(1);
    const task = r.make("Running", { status: "todo" });
    await until(() => r.asked.has(1));
    await expect(
      r.w.client.call("tasks", "archive", { taskId: task.id }),
    ).rejects.toThrow(/#1 has a run that has not ended/);
    expect(archived(r.w, task.id)).toBe(false);
    await r.w.client.call("tasks", "archive", {
      taskId: task.id,
      stopRuns: true,
    });
    expect(archived(r.w, task.id)).toBe(true);
    await until(() => settled(r.w, task.id));
    expect(detail(r.w, task.id).runs[0]!.status).toBe("interrupted");
    // The run ended after the archive, and the task is still away, in the status it had.
    expect(archived(r.w, task.id)).toBe(true);
    expect(detail(r.w, task.id).status).toBe("in_progress");
    const entry = r.board.activity(task.id).find((e) => e.kind === "archived")!;
    expect(entry.data.stoppedRuns).toEqual([detail(r.w, task.id).runs[0]!.id]);
    expect(kinds(r.w, task.id)).not.toContain("unarchived");
  });
});

describe("the lists", () => {
  it("leave archived tasks out unless asked, while progress and dependencies count them", async () => {
    const r = await room();
    const stage = r.make("Stage");
    const a = await r.finished("A", "done", stage.id);
    r.make("B", { parent: stage.id });
    const next = r.make("Next");
    await r.w.client.call("tasks", "addDependency", {
      taskId: next.id,
      dependsOn: a.id,
    });
    await r.w.client.call("tasks", "archive", { taskId: a.id });

    const numbers = (tasks: BoardTaskView[]) => tasks.map((t) => t.number);
    expect(numbers(r.board.list())).not.toContain(a.number);
    expect(numbers(r.board.list({ archived: "only" }))).toEqual([a.number]);
    expect(numbers(r.board.list({ archived: "include" }))).toContain(a.number);
    const listed = (archivedArg?: string) =>
      r.w.client.call(
        "tasks",
        "list",
        archivedArg === undefined
          ? {}
          : {
              archived: archivedArg,
            },
      ) as Promise<{ tasks: BoardTaskView[] }>;
    expect(numbers((await listed()).tasks)).not.toContain(a.number);
    expect(numbers((await listed("only")).tasks)).toEqual([a.number]);
    await expect(listed("all")).rejects.toThrow(/archived is only or include/);

    // The parent's progress and the dependency still see #2 as done.
    const stageView = r.board.list().find((t) => t.id === stage.id)!;
    expect(stageView.subtasks).toEqual({ total: 2, done: 1 });
    expect(detail(r.w, next.id).dependsOn).toEqual([
      expect.objectContaining({ number: a.number, state: "resolved" }),
    ]);
    // It is found by number and opens like any other.
    expect(r.board.find(`#${a.number}`)?.id).toBe(a.id);

    // The published board: the list without it, the archive with it.
    r.w.client.subscribe("tasks");
    await until(
      () =>
        r.w.client.section<BoardTaskView[]>("tasks", "archived")?.length === 1,
    );
    expect(
      numbers(r.w.client.section<BoardTaskView[]>("tasks", "list")!),
    ).not.toContain(a.number);
  });
});

describe("the setting", () => {
  it("is 7 days unless set, takes 3, 30 or never, and refuses anything else", async () => {
    const r = await room();
    const settings = () =>
      r.w.client.call("tasks", "setSettings", {}) as Promise<{
        settings: TaskBoardSettings;
      }>;
    expect((await settings()).settings).toEqual({
      archiveAfterDays: 7,
      reactToResults: false,
      autoAnswerAsks: false,
      draftTimeout: { enabled: false, minutes: 10, action: "discard" },
    });
    expect(
      await r.w.client.call("tasks", "setSettings", { archiveAfterDays: 30 }),
    ).toEqual({
      settings: {
        archiveAfterDays: 30,
        reactToResults: false,
        autoAnswerAsks: false,
        draftTimeout: { enabled: false, minutes: 10, action: "discard" },
      },
    });
    expect(
      await r.w.client.call("tasks", "setSettings", { archiveAfterDays: null }),
    ).toEqual({
      settings: {
        archiveAfterDays: null,
        reactToResults: false,
        autoAnswerAsks: false,
        draftTimeout: { enabled: false, minutes: 10, action: "discard" },
      },
    });
    await expect(
      r.w.client.call("tasks", "setSettings", { archiveAfterDays: 5 }),
    ).rejects.toThrow(/one of 3, 7, 30 or null/);
  });

  it("decides the days a sweep uses, and never sweeps when off", () => {
    const db = openDatabase(":memory:");
    applyMigrations(db, loadMigrations());
    const settings = new SettingStore(db);
    const asked: number[] = [];
    const archiver = new TaskArchiver({
      board: {
        archiveStale: (days: number) => {
          asked.push(days);
          return [];
        },
      },
      settings,
      timer: false,
    });
    archiver.sweep();
    settings.set("tasks.archiveAfterDays", 3);
    archiver.sweep();
    settings.set("tasks.archiveAfterDays", 30);
    archiver.sweep();
    settings.set("tasks.archiveAfterDays", null);
    archiver.sweep();
    expect(asked).toEqual([7, 3, 30]);
  });

  it("sweeps with the days that are set, on a real board", async () => {
    const r = await room();
    const task = await r.finished("Done");
    const now = lastAt(r.w, task.id) + 4 * DAY;
    const sweep = () =>
      new TaskArchiver({
        board: r.board,
        settings: new SettingStore(
          openDatabase(databasePath(r.w.host.dataDir)),
        ),
        timer: false,
        now: () => now,
      }).sweep();
    expect(sweep()).toEqual([]);
    await r.w.client.call("tasks", "setSettings", { archiveAfterDays: 3 });
    expect(sweep()).toEqual([task.id]);
  });
});

describe("0054-task-archive", () => {
  it("adds the columns and keeps every task and entry as it was", () => {
    const all = loadMigrations();
    const db = openDatabase(":memory:");
    applyMigrations(
      db,
      all.slice(
        0,
        all.findIndex((m) => m.id === "0054-task-archive"),
      ),
    );
    db.exec(
      "INSERT INTO task (id, title, description, status, created_at, updated_at) VALUES ('t1', 'Old', 'd', 'done', 1, 2), ('t2', 'Older', '', 'cancelled', 1, 3)",
    );
    db.exec(
      `INSERT INTO task_activity (id, task_id, kind, actor, body, data, created_at) VALUES
       ('a1', 't1', 'created', 'user', NULL, '{"status":"todo"}', 1),
       ('a2', 't1', 'comment', 'user', 'hi', '{}', 2),
       ('a3', 't2', 'subtask', 'system', NULL, '{"action":"all_cancelled"}', 3)`,
    );
    const tasks = db.query("SELECT * FROM task ORDER BY id").all();
    const entries = db
      .query("SELECT rowid, * FROM task_activity ORDER BY rowid")
      .all();

    applyMigrations(db, all);

    expect(
      db
        .query<Record<string, unknown>, []>("SELECT * FROM task ORDER BY id")
        .all(),
    ).toEqual(
      tasks.map((row) => ({
        ...(row as object),
        archived_at: null,
        archived_by: null,
      })),
    );
    expect(
      db.query("SELECT rowid, * FROM task_activity ORDER BY rowid").all(),
    ).toEqual(entries);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // The new kinds are allowed; a made-up one still is not.
    db.exec(
      "INSERT INTO task_activity (id, task_id, kind, actor, data, created_at) VALUES ('a4', 't1', 'archived', 'system', '{}', 4)",
    );
    expect(() =>
      db.exec(
        "INSERT INTO task_activity (id, task_id, kind, actor, data, created_at) VALUES ('a5', 't1', 'bogus', 'system', '{}', 5)",
      ),
    ).toThrow();
  });
});
