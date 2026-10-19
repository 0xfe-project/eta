/**
 * The task board: the `tasks` target and one `tasks.<id>` target per task.
 *
 * A task is a piece of work the user can see and move: a number (so a conversation can say "#12"
 * and mean one task forever), a status, an executor, and a timeline of what happened to it. This is
 * the product's board, not the session's own todo list (`Task` in `data.ts`): the two have nothing
 * in common but the word.
 *
 * Only agents make tasks, and the agent that made one executes it: every run is a fresh session
 * of that agent in a workspace of the task's project (`TaskWorkspace`). The user confirms the
 * draft that starts it, moves it between statuses, comments (a comment reaches a run that is
 * going), interrupts a run, and reruns the task.
 *
 * `tasks` is eager and publishes the whole board as one `list`. Every task is a target of its own
 * (`tasks.<id>`) with its `task` and its `activity`, so a comment moves one section of one target
 * and not the list. A run's log is its session's transcript: `sessions.<run.sessionId>`. A task
 * and a conversation meet in two places: a task may be linked to one (`conversationId`), and a
 * draft an agent proposes is a row of that conversation's timeline (`task_draft`) that becomes
 * the task's card (`task_card`) when the user confirms it.
 *
 * Times are epoch milliseconds. Names carry a `Board`/`Task` prefix because `Task` and
 * `TaskStatus` already mean the session's todo items.
 */
import type { CallFrame } from "@eta/client-wire-proto";
import type { MessageView } from "./product";

/* ------------------------------------------------------------------ views */

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type BoardTaskStatus = (typeof TASK_STATUSES)[number];

/** Where the executor works: a git worktree of its own, or the project's directory itself. */
export const TASK_WORKSPACE_MODES = ["worktree", "local"] as const;
export type TaskWorkspaceMode = (typeof TASK_WORKSPACE_MODES)[number];

/** A run is active while it starts or works; the rest are over. */
export const TASK_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "completed",
  "failed",
  "interrupted",
] as const;
export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

/** Why a queued run waits: the task's previous run, its machine's limit, or the machine being away. */
export type TaskQueueReason = "task_busy" | "machine_full" | "machine_offline";

/** Who did something to a task. `agentId` is set for an agent (which may have been deleted since). */
export interface TaskActor {
  kind: "user" | "agent" | "system";
  agentId: string | null;
}

/** A task as the board lists it. */
export interface BoardTaskView {
  id: string;
  /** Never reused, not even after the task is deleted. */
  number: number;
  title: string;
  status: BoardTaskStatus;
  /**
   * Who made it, and so who executes it when it is an agent. A task made before tasks ran has the
   * user here and no executor: it stays a note on the board.
   */
  createdBy: TaskActor & { kind: "user" | "agent" };
  /** The conversation it is discussed in, if linked. */
  conversationId: string | null;
  /** The status of its newest run; null before the first. */
  runStatus: TaskRunStatus | null;
  comments: number;
  createdAt: number;
  /** Moves on every change, comment and artifact: the board is ordered by it, newest first. */
  updatedAt: number;
}

/** The newest version of an artifact published for a task. */
export interface TaskArtifactRef {
  artifactId: string;
  title: string;
  version: number;
}

/** Where a task's runs work, on the project's machine. */
export interface TaskWorkspace {
  mode: TaskWorkspaceMode;
  /** The worktree's directory, once a run has made it; kept after the run. */
  path: string | null;
  /** The worktree's branch (`eta/task-<number>`); null in `local`. */
  branch: string | null;
}

/** One attempt of the executor at the task: a fresh session, whose transcript is the run's log. */
export interface TaskRunView {
  id: string;
  status: TaskRunStatus;
  /** Why it waits, while it is `queued`. */
  queueReason: TaskQueueReason | null;
  machineId: string | null;
  /** The session it works in (`sessions.<id>` is its live transcript); null until it has started. */
  sessionId: string | null;
  /** The directory the session works in. */
  workspace: string | null;
  /** It was reminded once that a run ends with `finish_task`. */
  nudged: boolean;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/** A task with what only its own page needs. */
export interface BoardTaskDetail extends BoardTaskView {
  description: string;
  artifacts: TaskArtifactRef[];
  /** The project the executor works in; null when the project is gone (or for a note). */
  projectId: string | null;
  workspace: TaskWorkspace;
  /** The conversation the task was proposed in: where the executor posts its result. */
  originConversationId: string | null;
  /** Oldest first. */
  runs: TaskRunView[];
}

/**
 * What happened to a task. `data` by kind: `created` has the `status` it started with (and the
 * `draftId` it was confirmed from); `status` and `title` have `from` and `to`; `conversation` has
 * `from` and `to` (conversation ids or null); `comment` has its text in `body`; `description` says
 * only that it changed; `artifact` has `artifactId`, `title` and `version`. The `run_*` kinds are a
 * run's life (`runId` names it): `run_started` has the `workspace` it works in, `run_failed` and
 * `run_interrupted` say why in `body`.
 */
export type TaskActivityKind =
  | "created"
  | "comment"
  | "status"
  | "title"
  | "description"
  | "conversation"
  | "artifact"
  | "run_queued"
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_interrupted"
  | "run_nudged";

export interface TaskActivityView {
  id: string;
  kind: TaskActivityKind;
  /** The run the entry is about, for the `run_*` kinds. */
  runId: string | null;
  actor: TaskActor;
  body: string | null;
  data: Record<string, unknown>;
  createdAt: number;
}

/* ------------------------------------------------------------------ timeline rows */

/** `MessageView.data` of a `task_draft` row: what the user is asked to confirm. */
export interface TaskDraftData {
  title: string;
  /** Markdown: goal, what was decided, acceptance, and where it came from. */
  description: string;
  /** Where the executor will work, as the agent chose it. */
  workspace: TaskWorkspaceMode;
}

/**
 * `MessageView.data` of a `task_card` row: the task's facts, refreshed (and the row's `revision`
 * bumped) whenever the task changes. A deleted task leaves its card behind with `deleted: true`
 * and the facts it had.
 */
export interface TaskCardData {
  taskId: string;
  number: number;
  title: string;
  status: BoardTaskStatus;
  runStatus: TaskRunStatus | null;
  /** Where the task is linked now, which is not always the conversation the card is in. */
  conversationId: string | null;
  comments: number;
  /** The latest comment, or empty. */
  summary: string;
  artifacts: TaskArtifactRef[];
  deleted?: true;
}

/* ------------------------------------------------------------------ sections */

/** `tasks`: eager. */
export interface TaskListSections {
  list: BoardTaskView[];
}
/** `tasks.<id>`: registered for every task, from startup or from its creation, until it is deleted. */
export interface TaskDetailSections {
  task: BoardTaskDetail;
  /** Oldest first. */
  activity: TaskActivityView[];
}

/* ------------------------------------------------------------------ actions */

export const TASK_ACTIONS = [
  "update",
  "comment",
  "delete",
  "link",
  "confirmDraft",
  "interrupt",
  "rerun",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** What may be changed about a task, and what a draft may be edited to on its way to the board. */
export interface TaskFields {
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
}

export interface TaskArgs {
  /**
   * Moving a task to `done` or `cancelled` stops its runs. There is no `create`: tasks are made
   * by agents, with their tools, and confirmed by the user (`confirmDraft`).
   */
  update: TaskFields & { taskId: string };
  /**
   * A comment on a task whose run is going is delivered to that run's session, which carries on
   * with it. A retry with the same `clientId` returns the comment already added instead of adding
   * another.
   */
  comment: { taskId: string; body: string; clientId?: string };
  /**
   * The task goes, and its activity with it; its cards stay in the timelines, marked deleted. A
   * task with a run going cannot be deleted.
   */
  delete: { taskId: string };
  /** Null unlinks. */
  link: { taskId: string; conversationId: string | null };
  /**
   * Turn a `task_draft` row of the conversation into a task and the row into its `task_card`, and
   * start its first run. Confirming again, from a second click or a retry, returns the same task.
   */
  confirmDraft: {
    conversationId: string;
    messageId: string;
    edits?: TaskFields;
  };
  /** Stop a run: a queued one never starts, a going one is told to stop and ends `interrupted`. */
  interrupt: { taskId: string; runId: string };
  /** A new run of the task, in a fresh session with no memory of the earlier ones. */
  rerun: { taskId: string };
}
export interface TaskResults {
  update: { task: BoardTaskDetail };
  comment: { task: BoardTaskDetail; activity: TaskActivityView };
  delete: { taskId: string };
  link: { task: BoardTaskDetail };
  confirmDraft: { task: BoardTaskDetail; message: MessageView };
  interrupt: { task: BoardTaskDetail };
  rerun: { task: BoardTaskDetail; run: TaskRunView };
}
export type TaskCall = {
  [A in TaskAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "tasks";
    action: A;
    args: TaskArgs[A];
  };
}[TaskAction];
