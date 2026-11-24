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
  /** The branch or commit the worktree starts at, as the proposer named it; null is the checkout's HEAD. */
  baseBranch: string | null;
  captainAssignmentId: string | null;
  captainMessageId: string | null;
  /** The task it is a subtask of. */
  parentId: string | null;
  /** The agent that executes it, when that is not the maker; null is the maker. */
  assigneeAgentId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  originConversationId: string | null;
}

/**
 * The agent that executes a task — runs it, on whose machine, in whose session: the assignee when
 * one was named, else the maker. A task the user made has only its assignee; a task made before
 * assignees existed has only its maker. Everything that asks "who runs this" asks here.
 */
export function executorOf(task: {
  assigneeAgentId: string | null;
  createdBy: { agentId: string | null };
}): string | null {
  return task.assigneeAgentId ?? task.createdBy.agentId;
}

export interface NewTask {
  title: string;
  description?: string | undefined;
  status?: BoardTaskStatus | undefined;
  /** The agent that makes it, and executes it unless someone else is assigned; absent is the user (a task that cannot run). */
  createdByAgent?: string | undefined;
  /** The agent that executes it, when that is not the maker. */
  assigneeAgent?: string | undefined;
  /** The branch or commit its worktree starts at; null is the project checkout's HEAD. */
  baseBranch?: string | null | undefined;
  captainAssignmentId?: string | null | undefined;
  captainMessageId?: string | null | undefined;
  /** The task it is a subtask of; checking it is the graph's. */
  parentId?: string | null | undefined;
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
  /**
   * Why the status changed, kept on its entry, when the system moved it for a reason a later
   * change has to recognize (`dependency_cancelled`).
   */
  statusReason?: string | undefined;
}

/** One edge of the graph as stored: `taskId` waits for `dependsOnId`. */
export interface DependencyRecord {
  taskId: string;
  dependsOnId: string;
  requireDone: boolean;
  createdAt: number;
}

interface DependencyRow {
  task_id: string;
  depends_on_id: string;
  require_done: number;
  created_at: number;
}

const dependencyOf = (row: DependencyRow): DependencyRecord => ({
  taskId: row.task_id,
  dependsOnId: row.depends_on_id,
  requireDone: row.require_done === 1,
  createdAt: row.created_at,
});

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
  base_branch: string | null;
  captain_assignment_id: string | null;
  captain_message_id: string | null;
  parent_id: string | null;
  assignee_agent: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  origin_conversation_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archived_by: string | null;
  comments: number;
  run_status: string | null;
  run_started_at: number | null;
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
  baseBranch: row.base_branch,
  captainAssignmentId: row.captain_assignment_id,
  captainMessageId: row.captain_message_id,
  parentId: row.parent_id,
  assigneeAgentId: row.assignee_agent,
  worktreePath: row.worktree_path,
  worktreeBranch: row.worktree_branch,
  originConversationId: row.origin_conversation_id,
  runStatus: row.run_status as TaskRunStatus | null,
  runStartedAt: row.run_started_at,
  createdBy:
    row.created_by_agent === null
      ? { kind: "user", agentId: null }
      : { kind: "agent", agentId: row.created_by_agent },
  conversationId: row.conversation_id,
  comments: row.comments,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at,
  archivedBy: row.archived_by,
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

/**
 * A task with its comment count and its executor's newest run's status and start, which the board
 * and every card show: a mentioned agent answering is not the task running.
 */
const SELECT_TASK = `
  SELECT t.*,
         (SELECT COUNT(*) FROM task_activity a WHERE a.task_id = t.id AND a.kind = 'comment') AS comments,
         (SELECT r.status FROM task_run r WHERE r.task_id = t.id AND r.agent_id IS NULL ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS run_status,
         (SELECT COALESCE(r.started_at, r.created_at) FROM task_run r WHERE r.task_id = t.id AND r.agent_id IS NULL ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS run_started_at
    FROM task t`;

/** The kinds that put a task away and bring it back: the only entries that do not bring it back. */
const ARCHIVE_KINDS: readonly TaskActivityKind[] = ["archived", "unarchived"];

/** The ends of a run: the one an archive stopped does not bring its task back. */
const RUN_ENDS: readonly TaskActivityKind[] = [
  "run_completed",
  "run_failed",
  "run_interrupted",
];

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
             (id, title, description, status, created_by_agent, assignee_agent, conversation_id, origin_conversation_id,
              project_id, workspace_mode, base_branch, captain_assignment_id, captain_message_id,
              parent_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.description ?? "",
          status,
          input.createdByAgent ?? null,
          input.assigneeAgent ?? null,
          input.conversationId ?? null,
          input.conversationId ?? null,
          input.projectId ?? null,
          input.workspaceMode ?? "local",
          input.baseBranch ?? null,
          input.captainAssignmentId ?? null,
          input.captainMessageId ?? null,
          input.parentId ?? null,
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
      entries.push([
        "status",
        {
          from: before.status,
          to: next.status,
          ...(changes.statusReason === undefined
            ? {}
            : { reason: changes.statusReason }),
        },
      ]);
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

  /** Add to what an entry of the timeline keeps (`data`), as a later fact about it. */
  annotate(activityId: string, data: Record<string, unknown>): void {
    this.#db
      .query("UPDATE task_activity SET data = json_patch(data, ?) WHERE id = ?")
      .run(JSON.stringify(data), activityId);
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

  /* ---------------------------------------------------------------- the graph's rows */

  /** Every edge, oldest first: the graph is read whole, since a rule can reach across it. */
  dependencies(): DependencyRecord[] {
    return this.#db
      .query<DependencyRow, []>(
        "SELECT * FROM task_dependency ORDER BY created_at, rowid",
      )
      .all()
      .map(dependencyOf);
  }

  /**
   * `taskId` waits for `dependsOnId`. Returns what was there before (undefined when the edge is
   * new), so the caller can say what changed. Checking it is the graph's, not this.
   */
  setDependency(
    taskId: string,
    dependsOnId: string,
    requireDone: boolean,
  ): DependencyRecord | undefined {
    const before = this.#db
      .query<DependencyRow, [string, string]>(
        "SELECT * FROM task_dependency WHERE task_id = ? AND depends_on_id = ?",
      )
      .get(taskId, dependsOnId);
    this.#db
      .query(
        `INSERT INTO task_dependency (task_id, depends_on_id, require_done, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, depends_on_id) DO UPDATE SET require_done = excluded.require_done`,
      )
      .run(taskId, dependsOnId, requireDone ? 1 : 0, Date.now());
    return before === null ? undefined : dependencyOf(before);
  }

  /** Whether there was such an edge to take away. */
  removeDependency(taskId: string, dependsOnId: string): boolean {
    return (
      this.#db
        .query(
          "DELETE FROM task_dependency WHERE task_id = ? AND depends_on_id = ?",
        )
        .run(taskId, dependsOnId).changes > 0
    );
  }

  /** Make the task a subtask of another, or (null) of none. Checking it is the graph's. */
  setParent(id: string, parentId: string | null): void {
    this.#db
      .query("UPDATE task SET parent_id = ?, updated_at = ? WHERE id = ?")
      .run(parentId, Date.now(), id);
  }

  /** The newest `status` entry of a task: who moved it last, and why. */
  lastStatusEntry(taskId: string): TaskActivityView | undefined {
    const row = this.#db
      .query<ActivityRow, [string]>(
        `SELECT * FROM task_activity WHERE task_id = ? AND kind = 'status'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId);
    return row === null ? undefined : activityOf(row);
  }

  /* ---------------------------------------------------------------- archiving */

  /**
   * Put the task away, saying so on its timeline: who did it (`by`), and the rest of what the
   * entry keeps (`archivedEntry`). The caller decides whether it may be; this only writes it.
   */
  archive(
    id: string,
    by: string,
    actor: TaskActor,
    data: Record<string, unknown>,
    at: number = Date.now(),
  ): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          "UPDATE task SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?",
        )
        .run(at, by, at, id);
      this.#log(id, "archived", actor, { data: { by, ...data } });
    })();
  }

  /** Bring the task back to the board, saying why (`cause`: an entry's kind, or `manual`). */
  unarchive(id: string, actor: TaskActor, data: Record<string, unknown>): void {
    this.#db.transaction(() => {
      this.#db
        .query(
          "UPDATE task SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?",
        )
        .run(Date.now(), id);
      this.#log(id, "unarchived", actor, { data });
    })();
  }

  /** When each task's timeline last moved: the time of its newest entry. */
  lastActivity(): Map<string, number> {
    return new Map(
      this.#db
        .query<{ task_id: string; at: number }, []>(
          "SELECT task_id, MAX(created_at) AS at FROM task_activity GROUP BY task_id",
        )
        .all()
        .map((row) => [row.task_id, row.at]),
    );
  }

  /**
   * The rule that brings an archived task back, in the one place every timeline entry is written:
   * anything new on it (a comment, a status, a run, an artifact, the graph) means it is not put
   * away any more, whoever put it away. Only the entries of archiving itself are not news, and
   * neither is the end of a run the archive stopped, which arrives after it. The task comes back
   * with an entry that says what brought it.
   */
  #revive(
    taskId: string,
    kind: TaskActivityKind,
    runId: string | undefined,
  ): void {
    if (ARCHIVE_KINDS.includes(kind)) return;
    const row = this.#db
      .query<{ archived_at: number | null }, [string]>(
        "SELECT archived_at FROM task WHERE id = ?",
      )
      .get(taskId);
    if (row?.archived_at === null || row?.archived_at === undefined) return;
    if (runId !== undefined && RUN_ENDS.includes(kind)) {
      const archived = this.#db
        .query<{ data: string }, [string]>(
          `SELECT data FROM task_activity WHERE task_id = ? AND kind = 'archived'
            ORDER BY rowid DESC LIMIT 1`,
        )
        .get(taskId);
      const stopped = (
        JSON.parse(archived?.data ?? "{}") as { stoppedRuns?: unknown }
      ).stoppedRuns;
      if (Array.isArray(stopped) && stopped.includes(runId)) return;
    }
    this.#db
      .query(
        "UPDATE task SET archived_at = NULL, archived_by = NULL WHERE id = ?",
      )
      .run(taskId);
    this.#log(
      taskId,
      "unarchived",
      { kind: "system", agentId: null },
      {
        data: { cause: kind },
      },
    );
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
    this.#revive(taskId, kind, detail.runId);
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
