/**
 * The task board: the `tasks` target and one `tasks.<id>` target per task.
 *
 * A task is a piece of work the user can see and move: a number (so a conversation can say "#12"
 * and mean one task forever), a status, an assignee, and a timeline of what happened to it. This is
 * the product's board, not the session's own todo list (`Task` in `data.ts`): the two have nothing
 * in common but the word.
 *
 * `tasks` is eager and publishes the whole board as one `list`. Every task is a target of its own
 * (`tasks.<id>`) with its `task` and its `activity`, so a comment moves one section of one target
 * and not the list. A task and a conversation meet in two places: a task may be linked to one
 * (`conversationId`), and a draft an agent proposes is a row of that conversation's timeline
 * (`task_draft`) that becomes the task's card (`task_card`) when the user confirms it.
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

/** Who a task waits on: nobody, or the user (how an agent hands work back). */
export const TASK_ASSIGNEES = ["none", "user"] as const;
export type BoardTaskAssignee = (typeof TASK_ASSIGNEES)[number];

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
  assignee: BoardTaskAssignee;
  createdBy: TaskActor & { kind: "user" | "agent" };
  /** The conversation it is discussed in, if linked. */
  conversationId: string | null;
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

/** A task with what only its own page needs. */
export interface BoardTaskDetail extends BoardTaskView {
  description: string;
  artifacts: TaskArtifactRef[];
}

/**
 * What happened to a task. `data` by kind: `created` has the `status` and `assignee` it started
 * with (and the `draftId` it was confirmed from); `status`, `assignee` and `title` have `from` and
 * `to`; `conversation` has `from` and `to` (conversation ids or null); `comment` has its text in
 * `body`; `description` says only that it changed; `artifact` has `artifactId`, `title` and
 * `version`.
 */
export type TaskActivityKind =
  | "created"
  | "comment"
  | "status"
  | "assignee"
  | "title"
  | "description"
  | "conversation"
  | "artifact";

export interface TaskActivityView {
  id: string;
  kind: TaskActivityKind;
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
  assignee: BoardTaskAssignee;
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
  "create",
  "update",
  "comment",
  "delete",
  "link",
  "confirmDraft",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** What may be changed about a task, and what a draft may be edited to on its way to the board. */
export interface TaskFields {
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
  assignee?: BoardTaskAssignee;
}

export interface TaskArgs {
  /** Status defaults to `todo`. Made by the user; an agent makes tasks with its own tools. */
  create: TaskFields & { title: string; conversationId?: string };
  update: TaskFields & { taskId: string };
  comment: { taskId: string; body: string };
  /** The task goes, and its activity with it; its cards stay in the timelines, marked deleted. */
  delete: { taskId: string };
  /** Null unlinks. */
  link: { taskId: string; conversationId: string | null };
  /**
   * Turn a `task_draft` row of the conversation into a task and the row into its `task_card`.
   * Confirming again, from a second click or a retry, returns the same task.
   */
  confirmDraft: {
    conversationId: string;
    messageId: string;
    edits?: TaskFields;
  };
}
export interface TaskResults {
  create: { task: BoardTaskDetail };
  update: { task: BoardTaskDetail };
  comment: { task: BoardTaskDetail; activity: TaskActivityView };
  delete: { taskId: string };
  link: { task: BoardTaskDetail };
  confirmDraft: { task: BoardTaskDetail; message: MessageView };
}
export type TaskCall = {
  [A in TaskAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "tasks";
    action: A;
    args: TaskArgs[A];
  };
}[TaskAction];
