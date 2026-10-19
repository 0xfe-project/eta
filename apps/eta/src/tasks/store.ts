import type {
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskRunStatus,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * The task board's rows.
 *
 * A task is a number, a title, a status, an executor and a timeline. The timeline is the record:
 * every change writes its activity in the same transaction as the change, so "what happened to
 * this" is a read and not a reconstruction, and a card can show the last thing that happened
 * without asking anyone.
 */
import type { Database } from "bun:sqlite";

/** A task as stored: the view, and the description only its own page shows. */
export interface TaskRecord extends BoardTaskView {
  description: string;
  projectId: string | null;
  workspaceMode: TaskWorkspaceMode;
  worktreePath: string | null;
  worktreeBranch: string | null;
  originConversationId: string | null;
}

export interface NewTask {
  title: string;
  description?: string | undefined;
  status?: BoardTaskStatus | undefined;
  /** The agent that makes it, and executes it; absent is the user (a task that cannot run). */
  createdByAgent?: string | undefined;
  /** Where it is discussed, and, for good, where it came from. */
  conversationId?: string | undefined;
  projectId?: string | undefined;
  workspaceMode?: TaskWorkspaceMode | undefined;
  /** More for the `created` entry, e.g. the draft this task was confirmed from. */
  origin?: Record<string, unknown> | undefined;
}

export interface TaskChanges {
  title?: string | undefined;
  description?: string | undefined;
  status?: BoardTaskStatus | undefined;
  /** Null unlinks. */
  conversationId?: string | null | undefined;
}

interface TaskRow {
  number: number;
  id: string;
  title: string;
  description: string;
  status: string;
  created_by_agent: string | null;
  conversation_id: string | null;
  project_id: string | null;
  workspace_mode: string;
  worktree_path: string | null;
  worktree_branch: string | null;
  origin_conversation_id: string | null;
  created_at: number;
  updated_at: number;
  comments: number;
  run_status: string | null;
}

interface ActivityRow {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  actor: string;
  actor_agent: string | null;
  body: string | null;
  data: string;
  created_at: number;
}

const recordOf = (row: TaskRow): TaskRecord => ({
  id: row.id,
  number: row.number,
  title: row.title,
  description: row.description,
  status: row.status as BoardTaskStatus,
  projectId: row.project_id,
  workspaceMode: row.workspace_mode as TaskWorkspaceMode,
  worktreePath: row.worktree_path,
  worktreeBranch: row.worktree_branch,
  originConversationId: row.origin_conversation_id,
  runStatus: row.run_status as TaskRunStatus | null,
  createdBy:
    row.created_by_agent === null
      ? { kind: "user", agentId: null }
      : { kind: "agent", agentId: row.created_by_agent },
  conversationId: row.conversation_id,
  comments: row.comments,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const activityOf = (row: ActivityRow): TaskActivityView => {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A column that holds JSON can hold anything; a bad one degrades to empty.
  }
  return {
    id: row.id,
    kind: row.kind as TaskActivityKind,
    runId: row.run_id,
    actor: { kind: row.actor as TaskActor["kind"], agentId: row.actor_agent },
    body: row.body,
    data,
    createdAt: row.created_at,
  };
};

/** A task with its comment count and its newest run's status, which the board and every card show. */
const SELECT_TASK = `
  SELECT t.*,
         (SELECT COUNT(*) FROM task_activity a WHERE a.task_id = t.id AND a.kind = 'comment') AS comments,
         (SELECT r.status FROM task_run r WHERE r.task_id = t.id ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS run_status
    FROM task t`;

export class TaskStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Make a task, with its number and its first entry, in one write: a task whose timeline starts
   * in the middle is wrong, and so is a number given out twice.
   */
  create(input: NewTask): TaskRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const status = input.status ?? "todo";
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO task
             (id, title, description, status, created_by_agent, conversation_id, origin_conversation_id,
              project_id, workspace_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.description ?? "",
          status,
          input.createdByAgent ?? null,
          input.conversationId ?? null,
          input.conversationId ?? null,
          input.projectId ?? null,
          input.workspaceMode ?? "local",
          now,
          now,
        );
      this.#log(
        id,
        "created",
        input.createdByAgent === undefined
          ? { kind: "user", agentId: null }
          : { kind: "agent", agentId: input.createdByAgent },
        { data: { status, ...input.origin } },
      );
    })();
    return this.get(id)!;
  }

  get(id: string): TaskRecord | undefined {
    const row = this.#db
      .query<TaskRow, [string]>(`${SELECT_TASK} WHERE t.id = ?`)
      .get(id);
    return row === null ? undefined : recordOf(row);
  }

  /** A task by id or by number: the board says `12`, the wire says an id, and both are one task. */
  find(idOrNumber: string): TaskRecord | undefined {
    const byId = this.get(idOrNumber);
    if (byId !== undefined) return byId;
    if (!/^#?\d+$/.test(idOrNumber)) return undefined;
    const row = this.#db
      .query<TaskRow, [number]>(`${SELECT_TASK} WHERE t.number = ?`)
      .get(Number(idOrNumber.replace("#", "")));
    return row === null ? undefined : recordOf(row);
  }

  /** The board: the task touched last first. */
  list(): TaskRecord[] {
    return this.#db
      .query<TaskRow, []>(
        `${SELECT_TASK} ORDER BY t.updated_at DESC, t.number DESC`,
      )
      .all()
      .map(recordOf);
  }

  /**
   * Change a task, one entry per field that really changed: "status, title" as one entry cannot
   * answer when it moved to review. A change that changes nothing writes nothing and does not
   * touch the task.
   */
  update(
    id: string,
    changes: TaskChanges,
    actor: TaskActor,
  ): TaskRecord | undefined {
    const before = this.get(id);
    if (before === undefined) return undefined;
    const next = {
      title: changes.title ?? before.title,
      description: changes.description ?? before.description,
      status: changes.status ?? before.status,
      conversationId:
        changes.conversationId === undefined
          ? before.conversationId
          : changes.conversationId,
    };
    const entries: [TaskActivityKind, Record<string, unknown>][] = [];
    if (next.title !== before.title)
      entries.push(["title", { from: before.title, to: next.title }]);
    if (next.description !== before.description)
      entries.push(["description", {}]);
    if (next.status !== before.status)
      entries.push(["status", { from: before.status, to: next.status }]);
    if (next.conversationId !== before.conversationId) {
      entries.push([
        "conversation",
        { from: before.conversationId, to: next.conversationId },
      ]);
    }
    if (entries.length === 0) return before;
    this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE task
              SET title = ?, description = ?, status = ?, conversation_id = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          next.title,
          next.description,
          next.status,
          next.conversationId,
          Date.now(),
          id,
        );
      for (const [kind, data] of entries) this.#log(id, kind, actor, { data });
    })();
    return this.get(id);
  }

  /** The worktree a run made for the task: kept for the next run, and shown on the task. */
  setWorktree(id: string, path: string, branch: string): void {
    this.#db
      .query(
        "UPDATE task SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?",
      )
      .run(path, branch, Date.now(), id);
  }

  /** Something that happened to a task besides a change to its fields; it counts as touching it. */
  record(
    taskId: string,
    kind: TaskActivityKind,
    actor: TaskActor,
    detail: {
      body?: string;
      data?: Record<string, unknown>;
      runId?: string;
    } = {},
  ): TaskActivityView | undefined {
    if (this.get(taskId) === undefined) return undefined;
    return this.#db.transaction(() => {
      this.#db
        .query("UPDATE task SET updated_at = ? WHERE id = ?")
        .run(Date.now(), taskId);
      return this.#log(taskId, kind, actor, detail);
    })();
  }

  /** The comment a client already sent under `clientId` on this task, if any (a retry's twin). */
  commentByClientId(
    taskId: string,
    clientId: string,
  ): TaskActivityView | undefined {
    const row = this.#db
      .query<ActivityRow, [string, string]>(
        `SELECT * FROM task_activity
          WHERE task_id = ? AND kind = 'comment' AND json_extract(data, '$.clientId') = ?`,
      )
      .get(taskId, clientId);
    return row === null ? undefined : activityOf(row);
  }

  /** Remove a task and, with it, its timeline. */
  remove(id: string): boolean {
    return this.#db.query("DELETE FROM task WHERE id = ?").run(id).changes > 0;
  }

  /** Everything that happened to a task, oldest first. */
  activity(taskId: string): TaskActivityView[] {
    return this.#db
      .query<ActivityRow, [string]>(
        "SELECT * FROM task_activity WHERE task_id = ? ORDER BY rowid",
      )
      .all(taskId)
      .map(activityOf);
  }

  /** The newest comment's text, for a card's line; empty when there is none. */
  lastComment(taskId: string): string {
    return (
      this.#db
        .query<{ body: string | null }, [string]>(
          `SELECT body FROM task_activity
            WHERE task_id = ? AND kind = 'comment'
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(taskId)?.body ?? ""
    );
  }

  #log(
    taskId: string,
    kind: TaskActivityKind,
    actor: TaskActor,
    detail: {
      body?: string | undefined;
      data?: Record<string, unknown>;
      runId?: string | undefined;
    },
  ): TaskActivityView {
    const id = crypto.randomUUID();
    this.#db
      .query(
        `INSERT INTO task_activity (id, task_id, run_id, kind, actor, actor_agent, body, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        detail.runId ?? null,
        kind,
        actor.kind,
        actor.agentId,
        detail.body ?? null,
        JSON.stringify(detail.data ?? {}),
        Date.now(),
      );
    return activityOf(
      this.#db
        .query<ActivityRow, [string]>(
          "SELECT * FROM task_activity WHERE id = ?",
        )
        .get(id)!,
    );
  }
}
