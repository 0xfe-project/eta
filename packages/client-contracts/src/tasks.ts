/**
 * The task board: the `tasks` target and one `tasks.<id>` target per task.
 *
 * A task is a piece of work the user can see and move: a number (so a conversation can say "#12"
 * and mean one task forever), a status, an executor, and a timeline of what happened to it. This is
 * the product's board, not the session's own todo list (`Task` in `data.ts`): the two have nothing
 * in common but the word.
 *
 * Tasks are created by agents (`draft_task`, `create_task`, `create_subtask`) with an optional
 * `assignee`, or by the user via `tasks.create` with an explicit `assignee`. A task's executor is
 * `assigneeAgentId ?? createdBy.agentId`, fixed at creation time: every run is a session of that
 * agent in a workspace of the task's project (`TaskWorkspace`). The user confirms the draft that
 * starts it, moves it between statuses, comments (a comment reaches the executor: it steers the run
 * that is going, or wakes the task into another run in the same session when none is), interrupts a
 * run, and reruns the task from scratch.
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
import type { AttachmentView, MessageView } from "./product";

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

/**
 * Where a worktree starts: a branch name or commit, as the agent that proposed the task wrote it
 * (a `#number` naming another task is resolved to that task's `eta/task-<number>` branch before
 * it is stored). Null is the old default: the project checkout's HEAD.
 */
export type TaskBaseBranch = string | null;
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

/**
 * Why a queued run waits: the task's previous run, the tasks it depends on (`dependsOn` says which
 * are not resolved yet), its machine's limit, or the machine being away.
 */
export const TASK_QUEUE_REASONS = [
  "task_busy",
  "waiting_deps",
  "machine_full",
  "machine_offline",
] as const;
export type TaskQueueReason = (typeof TASK_QUEUE_REASONS)[number];

/**
 * Where one dependency stands: the task it waits for is in review or done (`resolved`; done only
 * when the edge requires it), not yet (`waiting`), or was cancelled and never will be
 * (`cancelled`: the user decides).
 */
export type TaskDependencyState = "resolved" | "waiting" | "cancelled";

/** Another task, as a task names it: enough to show it and go to it. */
export interface TaskRefView {
  taskId: string;
  number: number;
  title: string;
  status: BoardTaskStatus;
}

/**
 * Something a task's work still waits for: its own edge or a parent's (`via` names that parent),
 * not resolved yet (`waiting`) or never to be (`cancelled`).
 */
export interface TaskWaitView extends TaskRefView {
  state: Exclude<TaskDependencyState, "resolved">;
  /** The parent whose dependency this is, inherited; null for the task's own. */
  via: number | null;
}

/** One edge of the task graph, from the side of the task that reads it. */
export interface TaskDependencyView {
  /** The task at the other end: the one waited for, or the one waiting. */
  taskId: string;
  number: number;
  title: string;
  status: BoardTaskStatus;
  /** Only `done` resolves this edge; else `in_review` does too. */
  requireDone: boolean;
  state: TaskDependencyState;
}

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
   * Who made it, and so who executes it when it is an agent and `assigneeAgentId` is null. Tasks
   * created by the user via `tasks.create` have `kind: "user"` and an explicit `assigneeAgentId`;
   * legacy tasks made before tasks ran have `kind: "user"` and `assigneeAgentId: null`, leaving
   * them as notes on the board with no executor.
   */
  createdBy: TaskActor & { kind: "user" | "agent" };
  /**
   * The agent that executes it, when that is not the maker: a draft can be written on someone
   * else's behalf. Null (or a task made before this field) is the maker, as it always was.
   */
  assigneeAgentId: string | null;
  /** The conversation it is discussed in, if linked. */
  conversationId: string | null;
  /**
   * Where its runs work: the project's directory or a git worktree of it. Absent from a host older
   * than this field, which the page reads as not known.
   */
  workspaceMode?: TaskWorkspaceMode;
  /** The Captain instruction that authorized this task, when it came from one. */
  captainAssignmentId?: string | null;
  captainMessageId?: string | null;
  /** The status of its newest run; null before the first. */
  runStatus: TaskRunStatus | null;
  /**
   * When its executor's newest run started (or was queued, before it starts); null before the
   * first. A mentioned agent's run is not counted: it is not the task running. Absent from an older
   * host.
   */
  runStartedAt?: number | null;
  /**
   * The tasks it waits for: its first run (and a rerun) starts only once every one is resolved.
   * Absent from a host older than dependencies, which is none.
   */
  dependsOn?: TaskDependencyView[];
  /**
   * What its work still waits for, its parents' dependencies included: what the board says
   * "waiting for #12" with. Empty when it may start.
   */
  waitingOn?: TaskWaitView[];
  /** The task it is a subtask of. */
  parentId?: string | null;
  /**
   * Its subtasks, counted, when it has any: a task with subtasks does not run, and its status is
   * theirs. Cancelled subtasks are not counted.
   */
  subtasks?: { total: number; done: number } | null;
  comments: number;
  createdAt: number;
  /** Moves on every change, comment and artifact: the board is ordered by it, newest first. */
  updatedAt: number;
  /**
   * When it was archived: put away from the board's lists, still itself everywhere else (its page,
   * `#N`, dependencies, a parent's progress). Null, or absent from an older host, is on the board.
   * Anything new on its timeline, or a status moved off done or cancelled, brings it back.
   */
  archivedAt?: number | null;
  /** Who archived it: `auto` (the host, for a quiet done or cancelled task), `user`, or an agent's id. */
  archivedBy?: string | null;
  /**
   * What its own runs used, in brief: what a card or a row says. Null before its first run that
   * got a session (it used nothing, and says nothing). Absent from a host older than this field.
   * The whole breakdown is the task's `usage` section.
   */
  usage?: TaskUsageBrief | null;
  /**
   * The same with every task under it, at any depth, for a task that has subtasks: a parent does
   * no work of its own, so its card says this. Null when none of them has run; absent for a task
   * without subtasks (and from an older host).
   */
  usageWithSubtasks?: TaskUsageBrief | null;
}

/** A task's usage, as a card or a list row says it. */
export interface TaskUsageBrief {
  /** Null: not one of its runs reported tokens ("no token data", never 0). */
  tokens: TaskTokenTotals | null;
  /** The model that answered with the most tokens; null without data. */
  model: string | null;
  /** How many models answered: a card says the first, and `+N` for the rest. */
  models: number;
  runs: number;
  runsWithoutData: number;
  /**
   * The session of a run going now, where its live rate is (`sessions.<id>.metrics`); null when
   * none is. Only eta's own loop measures one.
   */
  liveSessionId: string | null;
}

/** Which tasks a list holds: those on the board (the default), only the archived ones, or both. */
export const TASK_ARCHIVED_FILTERS = ["only", "include"] as const;
export type TaskArchivedFilter = (typeof TASK_ARCHIVED_FILTERS)[number];

/** How many quiet days put a done or cancelled task away, as the setting offers; null is never. */
export const TASK_ARCHIVE_DAYS = [3, 7, 30] as const;
export type TaskArchiveDays = (typeof TASK_ARCHIVE_DAYS)[number];
export const DEFAULT_TASK_ARCHIVE_DAYS: TaskArchiveDays = 7;

/** What a draft nobody decided on is made into when its wait runs out: a task, or nothing. */
export const TASK_DRAFT_TIMEOUT_ACTIONS = ["accept", "discard"] as const;
export type TaskDraftTimeoutAction =
  (typeof TASK_DRAFT_TIMEOUT_ACTIONS)[number];
/** How many minutes a draft may wait, as the setting offers. */
export const TASK_DRAFT_TIMEOUT_MINUTES = {
  min: 1,
  max: 1440,
  default: 10,
} as const;

/** The host's own decision for a draft that waited too long; off by default. */
export interface TaskDraftTimeout {
  enabled: boolean;
  /** Whole minutes from `TASK_DRAFT_TIMEOUT_MINUTES.min` to `.max`. */
  minutes: number;
  /** `accept` confirms it as it stands, so the task starts; `discard` makes no task. */
  action: TaskDraftTimeoutAction;
}

/** The board's own settings, on `tasks`. */
export interface TaskBoardSettings {
  /** Days a done or cancelled task stays quiet before the host archives it; null never does. */
  archiveAfterDays: TaskArchiveDays | null;
  /** Whether a finished task's result wakes the agent that made it, to review and follow up. Off by default. */
  reactToResults: boolean;
  /** Whether the agent that made a task answers its executor's questions before the user is asked. */
  autoAnswerAsks: boolean;
  /** What happens to a draft nobody confirmed or discarded in time. Absent from a host that predates it. */
  draftTimeout?: TaskDraftTimeout | undefined;
}

/** The newest version of an artifact published for a task. */
export interface TaskArtifactRef {
  artifactId: string;
  title: string;
  version: number;
}

/**
 * Where a task's runs work: the project's directory, or a git worktree of it. A run whose agent is
 * pinned to another machine than the project's has neither there and works in that machine's home
 * instead; `TaskRunView.workspace` says where a run really worked.
 */
export interface TaskWorkspace {
  mode: TaskWorkspaceMode;
  /** Where the worktree starts: a branch or commit the proposer named; null is the project checkout's HEAD. */
  base: TaskBaseBranch;
  /** The worktree's directory, once a run has made it; kept after the run. */
  path: string | null;
  /** The worktree's branch (`eta/task-<number>`); null in `local`. */
  branch: string | null;
}

/** One attempt of the executor at the task, in the task's session; its transcript is its log. */
export interface TaskRunView {
  id: string;
  /**
   * Who works in the run: null for the task's executor; an agent's id for one that was mentioned on
   * the task and answers in its thread, in a session of its own, without taking the work over.
   */
  agentId: string | null;
  status: TaskRunStatus;
  /** Why it waits, while it is `queued`. */
  queueReason: TaskQueueReason | null;
  /** The machine the run works on: its agent's, when pinned to one; else the project's. */
  machineId: string | null;
  /** The session it works in (`sessions.<id>` is its live transcript); null until it has started. */
  sessionId: string | null;
  /**
   * The run whose session this one carries on, when it was woken by a comment instead of opening a
   * session of its own. Two runs with one session read as one line of work: the second knows what
   * the first did. `tasks.rerun` never sets it — a rerun forgets.
   */
  continuesRunId: string | null;
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
  /** The tasks that wait for this one; `state` is where each of their edges to it stands. */
  dependents?: TaskDependencyView[];
  /** Its subtasks, oldest first. */
  children?: TaskRefView[];
  /** Its parent, the parent's parent and so on, the top first: a breadcrumb. */
  ancestors?: TaskRefView[];
}

/**
 * What happened to a task. `data` by kind: `created` has the `status` it started with (and the
 * `draftId` it was confirmed from); `status` and `title` have `from` and `to`; `conversation` has
 * `from` and `to` (conversation ids or null); `comment` has its text in `body` (and, when files came
 * with it, `attachments`: `AttachmentView[]`; `imagesUnseenBy`: the agents it was handed to whose
 * model takes no images, so they got its pictures as files only); `description` says
 * only that it changed; `artifact` has `artifactId`, `title` and `version`. The `run_*` kinds are a
 * run's life (`runId` names it): `run_started` has the `workspace` it works in, `run_failed` and
 * `run_interrupted` say why in `body`. `dependency` is the graph: `action` (`added`, `removed`,
 * `required` when `requireDone` changed, `deleted` when the task waited for was deleted, `blocked`
 * when it was cancelled and the task stopped, `unblocked` when that was undone), and the task at the
 * other end as `taskId`, `number`, `title`, with `requireDone`. It has no `body`: each reader says
 * it in its own language from `data` (`dependencyEntry`); an entry written before that has its
 * words, in English, in `body`.
 * A `status` entry the system wrote because of a cancelled dependency has `reason:
 * "dependency_cancelled"`: only such a block is undone by the system.
 * `parent` is on a task whose parent changed (`from`, `to`: task refs or null, and `deleted` when
 * the parent left because it was deleted); `subtask` on the parent (`action`: `added`, `removed`,
 * `deleted`, with the subtask as `taskId`, `number`, `title`; or `all_cancelled`). Like
 * `dependency`, neither has a `body` (`parentEntry`, `subtaskEntry`). A `status` entry the system
 * wrote because the subtasks moved has `reason: "subtasks"` (or `"all_cancelled"`).
 * `archived` and `unarchived` are the task put away and brought back (`archivedEntry`,
 * `unarchivedEntry`); like the graph's kinds they have no `body`.
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
  | "run_nudged"
  | "dependency"
  | "parent"
  | "subtask"
  | "archived"
  | "unarchived";

/** What a `dependency` entry's `data` says, when it says it (see `TaskActivityKind`). */
export interface TaskDependencyEntry {
  action:
    | "added"
    | "removed"
    | "required"
    | "deleted"
    | "blocked"
    | "unblocked";
  /** The task at the other end; absent for `unblocked`. */
  number: number | null;
  /** Its id; null for `unblocked`, and for an entry written before the host kept it. */
  taskId: string | null;
  title: string;
  requireDone: boolean;
}

const DEPENDENCY_ACTIONS: readonly string[] = [
  "added",
  "removed",
  "required",
  "deleted",
  "blocked",
  "unblocked",
];

/** A `dependency` entry's `data` read, or undefined when it is not one this reader knows. */
export function dependencyEntry(
  data: Record<string, unknown>,
): TaskDependencyEntry | undefined {
  const action = data.action;
  if (typeof action !== "string" || !DEPENDENCY_ACTIONS.includes(action))
    return undefined;
  const number = typeof data.number === "number" ? data.number : null;
  if (number === null && action !== "unblocked") return undefined;
  return {
    action: action as TaskDependencyEntry["action"],
    number,
    taskId: typeof data.taskId === "string" ? data.taskId : null,
    title: typeof data.title === "string" ? data.title : "",
    requireDone: data.requireDone === true,
  };
}

/** A task at the other end of a graph entry, as the entry names it. */
export interface TaskEntryRef {
  number: number;
  /** Its id; null for an entry written before the host kept it, which only names the number. */
  taskId: string | null;
  title: string;
}

const entryRef = (value: unknown): TaskEntryRef | null => {
  if (typeof value !== "object" || value === null) return null;
  const { number, taskId, title } = value as Record<string, unknown>;
  return typeof number === "number"
    ? {
        number,
        taskId: typeof taskId === "string" ? taskId : null,
        title: typeof title === "string" ? title : "",
      }
    : null;
};

/** What a `parent` entry's `data` says: the parent it left, the one it went under, and why. */
export interface TaskParentEntry {
  from: TaskEntryRef | null;
  to: TaskEntryRef | null;
  /** It left `from` because `from` was deleted. */
  deleted: boolean;
}

/** A `parent` entry's `data` read, or undefined when it names no parent at all. */
export function parentEntry(
  data: Record<string, unknown>,
): TaskParentEntry | undefined {
  const from = entryRef(data.from);
  const to = entryRef(data.to);
  if (from === null && to === null) return undefined;
  return { from, to, deleted: data.deleted === true };
}

/** What a `subtask` entry's `data` says (see `TaskActivityKind`). */
export type TaskSubtaskEntry =
  | { action: "added" | "removed" | "deleted"; task: TaskEntryRef }
  | { action: "all_cancelled" };

/** A `subtask` entry's `data` read, or undefined when it is not one this reader knows. */
export function subtaskEntry(
  data: Record<string, unknown>,
): TaskSubtaskEntry | undefined {
  if (data.action === "all_cancelled") return { action: "all_cancelled" };
  const task = entryRef(data);
  if (
    task === null ||
    (data.action !== "added" &&
      data.action !== "removed" &&
      data.action !== "deleted")
  )
    return undefined;
  return { action: data.action, task };
}

/**
 * What an `archived` entry's `data` says: who (`by`: `auto`, `user` or an agent's id), why
 * (`reason`: `stale` when the host did it after `days` quiet days, `manual` otherwise), the runs it
 * stopped to do it (`stoppedRuns`), and, for a subtask put away with its parent, that parent
 * (`with`).
 */
export interface TaskArchivedEntry {
  by: string;
  reason: "stale" | "manual";
  days: number | null;
  stoppedRuns: string[];
  with: TaskEntryRef | null;
}

/** An `archived` entry's `data` read. */
export function archivedEntry(
  data: Record<string, unknown>,
): TaskArchivedEntry {
  return {
    by: typeof data.by === "string" ? data.by : "user",
    reason: data.reason === "stale" ? "stale" : "manual",
    days: typeof data.days === "number" ? data.days : null,
    stoppedRuns: Array.isArray(data.stoppedRuns)
      ? data.stoppedRuns.filter((id): id is string => typeof id === "string")
      : [],
    with: entryRef(data.with),
  };
}

/**
 * What an `unarchived` entry's `data` says: the kind of entry that brought the task back
 * (`cause`: `comment`, `status`, `run_started`, …), or `manual` when someone restored it, and the
 * parent it came back with (`with`).
 */
export interface TaskUnarchivedEntry {
  cause: TaskActivityKind | "manual";
  with: TaskEntryRef | null;
}

export function unarchivedEntry(
  data: Record<string, unknown>,
): TaskUnarchivedEntry {
  return {
    cause:
      typeof data.cause === "string"
        ? (data.cause as TaskActivityKind | "manual")
        : "manual",
    with: entryRef(data.with),
  };
}

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

/** The statuses a draft may propose: made and started, or made and kept for later. */
export const TASK_DRAFT_STATUSES = ["todo", "backlog"] as const;
export type TaskDraftStatus = (typeof TASK_DRAFT_STATUSES)[number];

/** What a draft proposes, reading a draft written before it could say as `todo`. */
export function draftStatus(
  draft: Pick<TaskDraftData, "status">,
): TaskDraftStatus {
  return draft.status === "backlog" ? "backlog" : "todo";
}

/** `MessageView.data` of a `task_draft` row: what the user is asked to confirm. */
export interface TaskDraftData {
  title: string;
  /** Markdown: goal, what was decided, acceptance, and where it came from. */
  description: string;
  /** Where the executor will work, as the agent chose it. */
  workspace: TaskWorkspaceMode;
  /**
   * Where the task goes on the board once confirmed, as the agent proposed it: `todo` starts its
   * first run at once, `backlog` only puts it on the board, to start when the user moves it to
   * todo. Absent on drafts written before a draft could say so, which are `todo` (`draftStatus`).
   */
  status?: TaskDraftStatus | undefined;
  /**
   * The branch (or `#number` of another task) the worktree starts at; the board resolves a
   * `#number` to `eta/task-<number>` when it makes the task. Absent is the project checkout's
   * HEAD, the old behavior.
   */
  base?: string | undefined;
  /**
   * The agent the work is for, when it is not the one proposing: an agent id. Absent is the
   * proposing agent, which executes it itself, as it always was.
   */
  assignee?: string | undefined;
  /**
   * The tasks it will wait for, checked and resolved to ids when it was drafted and checked again
   * when it is confirmed. Absent is none, as it always was.
   */
  dependsOn?: { taskId: string; requireDone: boolean }[] | undefined;
  /** The task it will be a subtask of, checked like `dependsOn`. Absent is none. */
  parentId?: string | undefined;
  /** The user discarded it: it waits for nothing and makes no task. Absent is still waiting. */
  discarded?: boolean | undefined;
  /**
   * The host decided it, not the user: the draft waited past the `draftTimeout` setting. Set on a
   * draft the host discarded; a draft it confirmed says so on its task's timeline.
   */
  autoHandled?: "timeout" | undefined;
  /** Why the host's own confirmation failed; it keeps the draft waiting and does not try again. */
  autoFailure?: string | undefined;
  /** The Captain instruction that authorized this draft, when it came from one. */
  captainAssignmentId?: string | undefined;
  captainMessageId?: string | undefined;
  /**
   * The reply row this draft came out of — the row the agent was writing when it proposed the
   * work. The page draws the draft inside that turn rather than as a block of its own on the
   * timeline, because that is what it is: a request the turn is making of the reader. Absent on
   * rows written before a draft belonged to a turn (and on any row whose turn is not known);
   * those are drawn on their own, as they always were.
   */
  turnMessageId?: string | undefined;
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
  /**
   * The reply row that proposed the task, carried over from the draft so the card stays in the
   * turn that wrote it once the draft has become a card. Absent the same way it is absent on a
   * draft, with the same meaning.
   */
  turnMessageId?: string | undefined;
  /** Captain dispatch provenance, preserved across `TaskCards.sync()` refreshes. */
  captainAssignmentId?: string | undefined;
  captainRound?: number | undefined;
  captainNote?: string | undefined;
  taskNumber?: number | undefined;
  deleted?: true;
}

/* ------------------------------------------------------------------ sections */

/** `tasks`: eager. `list` is the board, without the archived tasks, which are `archived`. */
export interface TaskListSections {
  list: BoardTaskView[];
  /** Archived tasks, the one archived last first. Absent from an older host. */
  archived?: BoardTaskView[];
  /** Absent from an older host. */
  settings?: TaskBoardSettings;
}
/** `tasks.<id>`: registered for every task, from startup or from its creation, until it is deleted. */
export interface TaskDetailSections {
  task: BoardTaskDetail;
  /** Oldest first. */
  activity: TaskActivityView[];
  /**
   * The tokens its runs used, its subtasks' included (`tasks.usage` with `includeSubtasks`). Pushed
   * again when a run ends or a generation of one is counted, here and on every task above it.
   * Absent from an older host.
   */
  usage?: TaskUsageView;
  /**
   * The plan its executor keeps with `create_step` / `update_step`, as it stood in the session of
   * the executor's latest run: the last known state once the run is over. Empty when the task has
   * not run, or its run made no steps. Read only. Absent from an older host.
   */
  steps?: TaskStepView[];
}

/* ------------------------------------------------------------------ steps */

export const TASK_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number];

/** One step of an executor's plan, in the order it made them. */
export interface TaskStepView {
  /** The session's own id for it (`t1`, `t2`…), never reused in that session. */
  id: string;
  content: string;
  status: TaskStepStatus;
}

/* ------------------------------------------------------------------ usage */

/**
 * Tokens summed over the messages that reported them. `total` is the four parts together; there is
 * no money here, only tokens.
 */
export interface TaskTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** A subset of `output`. Null when none of the messages broke reasoning out. */
  reasoning: number | null;
  total: number;
}

/**
 * A group of runs' tokens. `tokens` is null when not one of its messages reported any: that is "no
 * data", never "used nothing". `runsWithoutData` of the `runs` reported nothing at all.
 */
export interface TaskUsageGroup {
  tokens: TaskTokenTotals | null;
  runs: number;
  runsWithoutData: number;
}

/** One model's share: the model that answered, as the provider or runtime reported it. */
export interface TaskModelUsage extends TaskUsageGroup {
  provider: string;
  model: string;
}

/** One run's tokens. Only a run that got a session is here: a run that never started used nothing. */
export interface TaskRunUsage {
  runId: string;
  taskId: string;
  /** The agent that worked in it: the task's executor, or the agent mentioned in this lane. */
  agentId: string | null;
  /** It was a mentioned agent's answer, not the executor's work. */
  mentioned: boolean;
  status: TaskRunStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** Null: the run has no token data (its runtime said nothing, or it ran before counting began). */
  tokens: TaskTokenTotals | null;
  /** The models that answered in it, the most tokens first. */
  models: { provider: string; model: string; tokens: TaskTokenTotals | null }[];
}

/**
 * `tasks.usage`: what a task's runs used, in tokens. Every run of the task is counted (the
 * executor's and those of agents mentioned on it), and with `includesSubtasks` those of every task
 * under it, at any depth. Each run belongs to exactly one task, so the sums are of distinct runs and
 * nothing is counted twice; `taskIds` says which tasks went in.
 */
export interface TaskUsageView {
  taskId: string;
  includesSubtasks: boolean;
  taskIds: string[];
  /** Everything together. `totals.runsWithoutData` is the runs with no token data. */
  totals: TaskUsageGroup;
  /** By the model that answered, the most tokens first. */
  models: TaskModelUsage[];
  /** Oldest first. */
  runs: TaskRunUsage[];
}

/* ------------------------------------------------------------------ actions */

export const TASK_ACTIONS = [
  "create",
  "update",
  "comment",
  "delete",
  "link",
  "confirmDraft",
  "discardDraft",
  "interrupt",
  "rerun",
  "addDependency",
  "removeDependency",
  "setParent",
  "list",
  "archive",
  "unarchive",
  "setSettings",
  "workspaceFor",
  "usage",
  "attach",
  "unattach",
  "attachment",
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/**
 * One task of `tasks.create`: the user making tasks from the page's form, the press of "Create"
 * being the confirmation. `after` (earlier tasks of the same call it waits for) and `under` (the
 * earlier task it is a subtask of) are indexes into the call's `tasks`.
 */
export interface NewTaskArgs {
  title: string;
  description?: string;
  /** The agent that executes it: a name or an id. */
  assignee: string;
  dependsOn?: { task: string; requireDone?: boolean }[];
  after?: number[];
  under?: number;
  /**
   * Where its worktree starts, as `create_task`'s `base`: a branch, a commit, or `#N` (that task's
   * `eta/task-<N>` branch). An empty string is the project checkout's HEAD, whatever it waits for.
   * Absent is what the host derives when the run starts: the branch of the one unfinished task it
   * waits for in the same project, else HEAD. Only a worktree reads it.
   */
  base?: string;
}

/** `tasks.create`: every task made in one write, or none. */
export interface CreateTasksArgs {
  tasks: NewTaskArgs[];
  /** The task they go under (`#N` or id); also gives them its project and conversation. */
  parent?: string;
  /** Where they are discussed; with no parent, its project is where they work. */
  conversationId?: string;
  /** `todo` (start once what they wait for is there, the default) or `backlog`. */
  status?: "todo" | "backlog";
}

/** What may be changed about a task, and what a draft may be edited to on its way to the board. */
export interface TaskFields {
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
}

export interface TaskArgs {
  /**
   * The user's own tasks, from the page's form: the call is the user pressing "Create", the
   * confirmation an agent's draft waits for (`confirmDraft`). Agents cannot make tasks this way.
   */
  create: CreateTasksArgs;
  /** Moving a task to `done` or `cancelled` stops its runs. */
  update: TaskFields & { taskId: string };
  /**
   * A comment on a task is always read. A run of the task is going: it goes into that run's session
   * and steers it. None is going and the task is one an executor works on (`todo`, `in_progress`,
   * `in_review`, `blocked`): the comment queues a run that carries on in the task's session, so the
   * executor reads it with what it already did. `backlog`, `done` and `cancelled` are not worked on
   * any more, so their comments are only recorded. A retry with the same `clientId` returns the
   * comment already added instead of adding another, and so wakes nobody twice.
   */
  comment: {
    taskId: string;
    /** May be empty when the comment carries files. */
    body: string;
    clientId?: string;
    /**
     * Files uploaded with `attach` for this task, by id (at most `MAX_ATTACHMENTS`): they go to the
     * agents the comment reaches as files, and its pictures as images when their models take them.
     * Kept in the comment's `data.attachments`.
     */
    attachments?: string[];
    /**
     * Agents the comment mentions (ids). Each that is not the executor is woken in a run of its own
     * on the task to answer in the thread; the comment wakes the executor only when it mentions the
     * executor or nobody. Kept in the comment's `data.mentions`.
     */
    mentions?: string[];
  };
  /**
   * The task goes, and its activity with it; its cards stay in the timelines, marked deleted. A
   * task with a run going cannot be deleted.
   */
  delete: { taskId: string };
  /** Null unlinks. */
  link: { taskId: string; conversationId: string | null };
  /**
   * Turn a `task_draft` row of the conversation into a task and the row into its `task_card`, and
   * start its first run unless it lands in the backlog. The status is `edits.status` when given,
   * else the draft's own (`todo` for a draft that does not say). Confirming again, from a second click or a retry, returns the same task.
   */
  confirmDraft: {
    conversationId: string;
    messageId: string;
    edits?: TaskFields;
  };
  /**
   * Discard a `task_draft` row of the conversation: no task is made and the row stays, marked
   * `discarded`. Refused for a draft already confirmed or discarded.
   */
  discardDraft: { conversationId: string; messageId: string };
  /** Stop a run: a queued one never starts, a going one is told to stop and ends `interrupted`. */
  interrupt: { taskId: string; runId: string };
  /**
   * A new run of the task, in a session of its own that remembers nothing of the earlier runs. To
   * carry on where the executor left off, comment instead.
   */
  rerun: { taskId: string };
  /**
   * `taskId` waits for `dependsOn` (an id or `#N`). Refused when it would close a cycle (the error
   * names it), when `dependsOn` is cancelled, or is the task itself. Adding an edge that is there
   * changes only its `requireDone`.
   */
  addDependency: { taskId: string; dependsOn: string; requireDone?: boolean };
  removeDependency: { taskId: string; dependsOn: string };
  /**
   * Make the task a subtask of `parent` (an id or `#N`), or of none (null). Refused when the
   * parent is the task or one of its subtasks, or when it would close a cycle of waiting.
   */
  setParent: { taskId: string; parent: string | null };
  /** The board as `tasks.list` shows it: without the archived tasks unless `archived` asks for them. */
  list: { archived?: TaskArchivedFilter };
  /**
   * Put the task away, with its subtasks. Any status may be archived; a task with a run that has
   * not ended (its own or a subtask's) is refused unless `stopRuns` is set, which stops those runs
   * first, as `interrupt` does. Archiving a task that is archived already changes nothing.
   */
  archive: { taskId: string; stopRuns?: boolean };
  /** Bring tasks back to the board, each with its archived subtasks. */
  unarchive: { taskId?: string; taskIds?: string[] };
  setSettings: Partial<TaskBoardSettings>;
  /**
   * Where tasks made with `create` and these would work: the parent's workspace, else a worktree
   * for a conversation whose project is a git repository and its directory for one that is not.
   */
  workspaceFor: { parent?: string; conversationId?: string };
  /**
   * What the task's runs used, in tokens, by model and by run; with `includeSubtasks`, every task
   * under it too (each run counted once, under its own task). Read, not polled: the task's `usage`
   * section is pushed when it moves.
   */
  usage: { taskId: string; includeSubtasks?: boolean };
  /**
   * One chunk of a file on its way to a comment of the task, as `conversations.attach` is for a
   * message: in order from `index` 0, `data` in base64 (at most `ATTACH_CHUNK_BYTES`), `uploadId`
   * the client's uuid that becomes the attachment's id. The reply has the `attachment` once `last`
   * was sent.
   */
  attach: {
    taskId: string;
    uploadId: string;
    name: string;
    contentType?: string;
    index: number;
    last?: boolean;
    data: string;
  };
  /** Takes back a file of the task that no comment has carried yet. */
  unattach: { taskId: string; attachmentId: string };
  /** Reads a picture a comment of the task carried, to show it on the timeline. */
  attachment: { taskId: string; attachmentId: string };
}
export interface TaskResults {
  create: { tasks: BoardTaskDetail[] };
  update: { task: BoardTaskDetail };
  comment: { task: BoardTaskDetail; activity: TaskActivityView };
  delete: { taskId: string };
  link: { task: BoardTaskDetail };
  confirmDraft: { task: BoardTaskDetail; message: MessageView };
  discardDraft: { message: MessageView };
  interrupt: { task: BoardTaskDetail };
  rerun: { task: BoardTaskDetail; run: TaskRunView };
  addDependency: { task: BoardTaskDetail };
  removeDependency: { task: BoardTaskDetail };
  setParent: { task: BoardTaskDetail };
  list: { tasks: BoardTaskView[] };
  archive: { task: BoardTaskDetail };
  unarchive: { tasks: BoardTaskDetail[] };
  setSettings: { settings: TaskBoardSettings };
  workspaceFor: { mode: TaskWorkspaceMode };
  usage: { usage: TaskUsageView };
  attach: { attachment: AttachmentView | null };
  unattach: { removed: boolean };
  attachment: { contentType: string; data: string };
}
export type TaskCall = {
  [A in TaskAction]: Omit<CallFrame, "target" | "action" | "args"> & {
    target: "tasks";
    action: A;
    args: TaskArgs[A];
  };
}[TaskAction];
