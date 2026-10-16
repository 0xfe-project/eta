/**
 * The task board's rows (REFACTOR.md §9, P3.1 — the local half).
 *
 * A task is a number, a title, a status, an assignee and a timeline. The timeline is the record:
 * every change writes an activity row in the same transaction, so "what happened to this" is a
 * read rather than a reconstruction, and a card in a group can show the last thing that happened
 * without asking anyone.
 *
 * The number is allocated inside the transaction that inserts the row. That is the one thing that
 * must not race: two tasks created at once get two numbers, and a number is never reused — a group
 * that says "第 12 条" means one task forever.
 */
import type { Database } from "bun:sqlite";

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

/** Who a task is for. `remote` arrives with P4; until then a task is for the user or nobody. */
export type AssigneeKind = "none" | "user";

export type ActorKind = "user" | "agent" | "remote" | "system";

export interface TaskRecord {
  id: string;
  /** The human-facing number; never reused. */
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: AssigneeKind;
  createdByAgent?: string | undefined;
  groupId?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityRecord {
  id: string;
  taskId: string;
  kind: string;
  actor: ActorKind;
  actorAgent?: string | undefined;
  body?: string | undefined;
  data: Record<string, unknown>;
  createdAt: string;
}

/** A task and everything that happened to it: what a detail view reads. */
export interface TaskDetail extends TaskRecord {
  activity: ActivityRecord[];
}

export interface CreateTaskInput {
  title: string;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  assignee?: AssigneeKind | undefined;
  createdByAgent?: string | undefined;
  groupId?: string | undefined;
}

export interface UpdateTaskInput {
  title?: string | undefined;
  description?: string | undefined;
  status?: TaskStatus | undefined;
  assignee?: AssigneeKind | undefined;
  /** `null` unlinks the group; a string links it. */
  groupId?: string | null | undefined;
}

export interface ActivityInput {
  taskId: string;
  kind: string;
  actor: ActorKind;
  actorAgent?: string | undefined;
  body?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

const STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
];

export function isTaskStatus(value: string): value is TaskStatus {
  return (STATUSES as readonly string[]).includes(value);
}

export function isAssigneeKind(value: string): value is AssigneeKind {
  return value === "none" || value === "user";
}

interface TaskRow {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  assignee: string;
  created_by_agent: string | null;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  task_id: string;
  kind: string;
  actor: string;
  actor_agent: string | null;
  body: string | null;
  data: string;
  created_at: string;
}

const actorOf = (value: string): ActorKind =>
  value === "agent" || value === "remote" || value === "system"
    ? value
    : "user";

const toTask = (row: TaskRow): TaskRecord => ({
  id: row.id,
  number: row.number,
  title: row.title,
  description: row.description,
  status: isTaskStatus(row.status) ? row.status : "todo",
  assignee: row.assignee === "user" ? "user" : "none",
  ...(row.created_by_agent === null
    ? {}
    : { createdByAgent: row.created_by_agent }),
  ...(row.group_id === null ? {} : { groupId: row.group_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toActivity = (row: ActivityRow): ActivityRecord => {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return {
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    actor: actorOf(row.actor),
    ...(row.actor_agent === null ? {} : { actorAgent: row.actor_agent }),
    ...(row.body === null ? {} : { body: row.body }),
    data,
    createdAt: row.created_at,
  };
};

export class TaskStore {
  readonly #handle: Database;

  constructor(handle: Database) {
    this.#handle = handle;
  }

  /**
   * Create a task, with its number and its first activity.
   *
   * Both in one transaction: a task without its `created` row would be a task whose timeline
   * starts in the middle, and a number handed out twice is worse than a failed insert.
   */
  create(input: CreateTaskInput): TaskRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const status = input.status ?? "todo";
    this.#handle.transaction(() => {
      const next = this.#handle
        .query("SELECT COALESCE(MAX(number), 0) + 1 AS number FROM task")
        .get() as { number: number };
      this.#handle
        .query(
          `INSERT INTO task
             (id, number, title, description, status, assignee, created_by_agent, group_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          next.number,
          input.title,
          input.description ?? "",
          status,
          input.assignee ?? "none",
          input.createdByAgent ?? null,
          input.groupId ?? null,
          now,
          now,
        );
      this.record({
        taskId: id,
        kind: "created",
        actor: input.createdByAgent === undefined ? "user" : "agent",
        ...(input.createdByAgent === undefined
          ? {}
          : { actorAgent: input.createdByAgent }),
        data: { status, assignee: input.assignee ?? "none" },
      });
    })();
    return this.get(id)!;
  }

  /**
   * A task by id, or by its number — the board's links say `12`, the API says a uuid, and both
   * are the same task.
   */
  find(idOrNumber: string): TaskRecord | undefined {
    const byId = this.get(idOrNumber);
    if (byId !== undefined) return byId;
    if (!/^\d+$/.test(idOrNumber)) return undefined;
    const row = this.#handle
      .query("SELECT * FROM task WHERE number = ?")
      .get(Number(idOrNumber)) as TaskRow | null;
    return row === null ? undefined : toTask(row);
  }

  get(id: string): TaskRecord | undefined {
    const row = this.#handle
      .query("SELECT * FROM task WHERE id = ?")
      .get(id) as TaskRow | null;
    return row === null ? undefined : toTask(row);
  }

  /** The board: most recently updated first, optionally one group's tasks. */
  list(options: { groupId?: string | undefined } = {}): TaskRecord[] {
    const rows =
      options.groupId === undefined
        ? (this.#handle
            .query("SELECT * FROM task ORDER BY updated_at DESC, number DESC")
            .all() as TaskRow[])
        : (this.#handle
            .query(
              "SELECT * FROM task WHERE group_id = ? ORDER BY updated_at DESC, number DESC",
            )
            .all(options.groupId) as TaskRow[]);
    return rows.map(toTask);
  }

  detail(id: string): TaskDetail | undefined {
    const task = this.get(id);
    if (task === undefined) return undefined;
    return { ...task, activity: this.activity(id) };
  }

  /** Everything that happened to a task, oldest first. */
  activity(taskId: string): ActivityRecord[] {
    const rows = this.#handle
      .query(
        "SELECT * FROM task_activity WHERE task_id = ? ORDER BY created_at, rowid",
      )
      .all(taskId) as ActivityRow[];
    return rows.map(toActivity);
  }

  /**
   * Change what can be changed, recording each change as it happens.
   *
   * One activity per field, not one per request: a timeline that says "status, title" as one
   * entry cannot answer "when did it move to in_review".
   */
  update(
    id: string,
    input: UpdateTaskInput,
    actor: { kind: ActorKind; agentId?: string | undefined },
  ): TaskRecord | undefined {
    const before = this.get(id);
    if (before === undefined) return undefined;
    const now = new Date().toISOString();
    this.#handle.transaction(() => {
      this.#handle
        .query(
          `UPDATE task
              SET title = ?, description = ?, status = ?, assignee = ?, group_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.title ?? before.title,
          input.description ?? before.description,
          input.status ?? before.status,
          input.assignee ?? before.assignee,
          input.groupId === undefined
            ? (before.groupId ?? null)
            : input.groupId,
          now,
          id,
        );
      const record = (kind: string, data: Record<string, unknown>): void => {
        this.record({
          taskId: id,
          kind,
          actor: actor.kind,
          ...(actor.agentId === undefined ? {} : { actorAgent: actor.agentId }),
          data,
        });
      };
      if (input.title !== undefined && input.title !== before.title) {
        record("title", { from: before.title, to: input.title });
      }
      if (
        input.description !== undefined &&
        input.description !== before.description
      ) {
        record("description", {});
      }
      if (input.status !== undefined && input.status !== before.status) {
        record("status", { from: before.status, to: input.status });
      }
      if (input.assignee !== undefined && input.assignee !== before.assignee) {
        record("assignee", { from: before.assignee, to: input.assignee });
      }
      if (
        input.groupId !== undefined &&
        (input.groupId ?? undefined) !== before.groupId
      ) {
        record("group", { to: input.groupId ?? "" });
      }
    })();
    return this.get(id);
  }

  /** A comment on a task: an activity with a body, and the card's summary. */
  comment(
    id: string,
    body: string,
    actor: { kind: ActorKind; agentId?: string | undefined },
  ): ActivityRecord | undefined {
    if (this.get(id) === undefined) return undefined;
    const now = new Date().toISOString();
    this.#handle
      .query("UPDATE task SET updated_at = ? WHERE id = ?")
      .run(now, id);
    return this.record({
      taskId: id,
      kind: "comment",
      actor: actor.kind,
      ...(actor.agentId === undefined ? {} : { actorAgent: actor.agentId }),
      body,
    });
  }

  /**
   * Remove a task. Its activity goes with it, which is why the card in a group is told first:
   * the card is what a reader still has.
   */
  remove(id: string): boolean {
    return (
      this.#handle.query("DELETE FROM task WHERE id = ?").run(id).changes > 0
    );
  }

  record(input: ActivityInput): ActivityRecord {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.#handle
      .query(
        `INSERT INTO task_activity
           (id, task_id, kind, actor, actor_agent, body, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.kind,
        input.actor,
        input.actorAgent ?? null,
        input.body ?? null,
        JSON.stringify(input.data ?? {}),
        now,
      );
    const row = this.#handle
      .query("SELECT * FROM task_activity WHERE id = ?")
      .get(id) as ActivityRow | null;
    return toActivity(row!);
  }

  /** How many comments a task has: the count a card shows. */
  comments(taskId: string): number {
    const row = this.#handle
      .query(
        "SELECT COUNT(*) AS n FROM task_activity WHERE task_id = ? AND kind = 'comment'",
      )
      .get(taskId) as { n: number };
    return row.n;
  }

  /** The last comment's body, for a card's one-line summary; empty when there is none. */
  summary(taskId: string): string {
    const row = this.#handle
      .query(
        `SELECT body FROM task_activity
          WHERE task_id = ? AND kind = 'comment' AND body IS NOT NULL
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as { body: string | null } | null;
    return row?.body ?? "";
  }
}
