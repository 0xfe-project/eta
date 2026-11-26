import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  MessageView,
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskArchivedFilter,
  TaskArtifactRef,
  TaskDependencyView,
  TaskDraftTimeoutAction,
  TaskRefView,
  TaskWaitView,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * The task board: what can be done to tasks, whoever asks.
 *
 * The wire actions and the agents' tools are two ways in to the same handful of operations, and
 * what an operation owes does not depend on the way in: the fields are checked, the change and
 * the activity it leaves are one write, every card of the task is refreshed in that same write,
 * and then the people looking are told, the conversations whose cards moved and the board itself.
 * That is all this class is; the rows are `store.ts`, the cards `cards.ts`, and what the graph of
 * dependencies means is `graph.ts`, which the board asks and never second-guesses.
 */
import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agents/store";
import type { AttachmentStore } from "../conversations/attachments";
import type { ConversationStore } from "../conversations/store";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { DraftInput, TaskCards } from "./cards";
import type { GraphEdge, GraphTask } from "./graph";
import type { TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import { TASK_STATUSES } from "@eta/client-contracts";
import { checkExternalAgentProject } from "../agents/bounds";
import { viewOf as attachmentView } from "../conversations/attachments";
import {
  assigneeScopeFor,
  CAPTAIN_ASSIGNEE_ERROR,
  resolveAssignee,
} from "./assignee";
import { nameOf, TaskGraph } from "./graph";
import { finished, workable } from "./status";

/** A dependency as a caller names it: the task (`#N` or id), and whether only done resolves it. */
export interface DependencyInput {
  task: string;
  requireDone?: boolean | undefined;
}

/** One task of a batch the user makes (`TaskBoard.make`). */
export interface NewTaskInput {
  title: string;
  description?: string | undefined;
  /** Who executes it: an agent's name or id. */
  assignee: string;
  dependsOn?: readonly DependencyInput[] | undefined;
  /** Earlier tasks of the batch it waits for, by index. */
  after?: readonly number[] | undefined;
  /** An earlier task of the batch it is a subtask of, by index; else the batch's parent. */
  under?: number | undefined;
  /** Where its worktree starts (`#N`, a branch or a commit; empty is HEAD); absent is derived. */
  base?: string | undefined;
}

/** What the system writes on a parent's status it found stale and made again (`reconcile`). */
const RECOMPUTED = "recomputed";

/** A parent whose status moved in a write, and the conversations whose cards it touched. */
interface Moved {
  id: string;
  status: BoardTaskStatus;
  touched: string[];
}

/** What the system writes on a status it set because a dependency was cancelled. */
const DEPENDENCY_CANCELLED = "dependency_cancelled";

const SYSTEM: TaskActor = { kind: "system", agentId: null };

/** Something a viewer of the board may want to read again. */
export interface BoardChange {
  taskId: string;
  kind: "created" | "changed" | "removed";
}

/** The fields of a task as a caller sends them; anything that came off the wire is a `string`. */
export interface FieldsInput {
  title?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
}

/** The same fields once they have been checked. */
interface Fields {
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
}

/**
 * What the board asks of the runs of its tasks (`runner.ts` is the one that answers; it is made
 * after the board, because it works through the board, so it is attached afterwards).
 */
export interface TaskRuns {
  /** A task that may run was made (or moved out of the backlog): queue its first run. */
  start: (taskId: string) => void;
  /** The task is done or cancelled: its runs stop. */
  stop: (taskId: string, why: string) => void;
  /** The task is finished, archived or deleted: its worktree, if it has one, can go. */
  release?: (task: TaskRecord) => void;
  /** Whether a run of the task is starting or going. */
  active: (taskId: string) => boolean;
  /**
   * The executor's runs that have not started are withdrawn: they end interrupted, with no words
   * of their own, since the board's entry next to them says why. `start` (the default) takes only
   * the ones that would start the task's work (its first run, a rerun); `executor` takes every one,
   * the comment wakes too, for a task that will not run itself any more. Runs already going, and
   * mentioned agents' runs, are left alone.
   */
  withdraw: (taskId: string, which?: "start" | "executor") => void;
  /** Something that decides whether a queued run may start has changed: look at the queue again. */
  pump: () => void;
  /**
   * A comment on the task, for whoever should read it: the executor's run, and the agents it
   * mentions. `wake: false` only hands it to a run that is going (a mentioned agent's answer).
   */
  deliver: (
    taskId: string,
    activity: TaskActivityView,
    options?: { wake?: boolean },
  ) => void;
}

export interface TaskBoardDeps {
  db: Database;
  tasks: TaskStore;
  runs: TaskRunStore;
  cards: TaskCards;
  conversations: ConversationStore;
  projects: ProjectStore;
  machines: MachineStore;
  /** Who an assignee is: the caller names it, the task keeps the registry's id. */
  agents: Pick<AgentStore, "get" | "list">;
  /** The newest version of each artifact published for a task. */
  artifactsOf: (taskId: string) => TaskArtifactRef[];
  /** These conversations' timelines moved. */
  changed: (conversationIds: readonly string[]) => void;
  /** The files people attach to comments (the conversations' store: a file is a task's or a chat's). */
  attachments?: AttachmentStore | undefined;
}

/** A task as the graph needs it. */
const graphTaskOf = (task: TaskRecord): GraphTask => ({
  id: task.id,
  number: task.number,
  title: task.title,
  status: task.status,
  projectId: task.projectId,
  workspaceMode: task.workspaceMode,
  parentId: task.parentId,
});

/** Another task, as one names it. */
const refOf = (task: GraphTask): TaskRefView => ({
  taskId: task.id,
  number: task.number,
  title: task.title,
  status: task.status,
});

/** What the task's work still waits for, its parents' edges included. */
const waitingOnOf = (graph: TaskGraph, id: string): TaskWaitView[] =>
  graph.heldBy(id).flatMap((edge) => {
    const state = graph.stateOf(edge);
    if (state === "resolved") return [];
    const owner = graph.task(edge.taskId)!;
    return [
      {
        ...refOf(graph.task(edge.dependsOnId)!),
        state,
        via: edge.inherited ? owner.number : null,
      },
    ];
  });

/** Its subtasks, counted without the cancelled ones; null for a task that has none. */
const subtasksOf = (
  graph: TaskGraph,
  id: string,
): { total: number; done: number } | null => {
  const children = graph.childrenOf(id);
  if (children.length === 0) return null;
  const live = children.filter((child) => child.status !== "cancelled");
  return {
    total: live.length,
    done: live.filter((child) => child.status === "done").length,
  };
};

/** One end of an edge, as the task at the other end reads it. */
const endOf = (
  graph: TaskGraph,
  edge: GraphEdge,
  other: string,
): TaskDependencyView => {
  const task = graph.task(other)!;
  return {
    taskId: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    requireDone: edge.requireDone,
    state: graph.stateOf(edge),
  };
};

/** What the task waits for, each edge with where it stands. */
const dependsOnOf = (graph: TaskGraph, id: string): TaskDependencyView[] =>
  graph.dependenciesOf(id).map((edge) => endOf(graph, edge, edge.dependsOnId));

/** A task as the board lists it: without what only its own page shows. */
const viewOf = (task: TaskRecord, graph: TaskGraph): BoardTaskView => ({
  id: task.id,
  number: task.number,
  title: task.title,
  status: task.status,
  createdBy: task.createdBy,
  assigneeAgentId: task.assigneeAgentId,
  conversationId: task.conversationId,
  workspaceMode: task.workspaceMode,
  captainAssignmentId: task.captainAssignmentId,
  captainMessageId: task.captainMessageId,
  runStatus: task.runStatus,
  runStartedAt: task.runStartedAt,
  dependsOn: dependsOnOf(graph, task.id),
  waitingOn: waitingOnOf(graph, task.id),
  parentId: task.parentId,
  subtasks: subtasksOf(graph, task.id),
  comments: task.comments,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  archivedAt: task.archivedAt ?? null,
  archivedBy: task.archivedBy ?? null,
});

const DAY = 24 * 60 * 60 * 1000;

export class TaskBoard {
  readonly #deps: TaskBoardDeps;
  readonly #listeners = new Set<(change: BoardChange) => void>();
  #runs: TaskRuns | undefined;
  /** Settling the graph changes statuses, which asks for settling again: once is enough. */
  #settling = false;

  constructor(deps: TaskBoardDeps) {
    this.#deps = deps;
  }

  /** The runner that answers for the runs of tasks; until it is attached, tasks do not run. */
  attach(runs: TaskRuns): void {
    this.#runs = runs;
  }

  /** Be told of every change to the board, until the returned function is called. */
  onChange(listener: (change: BoardChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /* ---------------------------------------------------------------- reads */

  /**
   * The board's tasks, the one touched last first: without the archived ones, unless `archived`
   * asks for them (`only`: those alone, the one archived last first). The graph every view is
   * read against is always the whole board, so a parent's progress and a dependency count an
   * archived task like any other.
   */
  list(
    options: { archived?: TaskArchivedFilter | undefined } = {},
  ): BoardTaskView[] {
    const tasks = this.#deps.tasks.list();
    const graph = this.#graphOf(tasks);
    const archived = (task: TaskRecord): boolean =>
      task.archivedAt !== null && task.archivedAt !== undefined;
    const chosen =
      options.archived === "include"
        ? tasks
        : options.archived === "only"
          ? tasks
              .filter(archived)
              .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
          : tasks.filter((task) => !archived(task));
    return chosen.map((task) => viewOf(task, graph));
  }

  /** The graph as it is now, to ask (`graph.ts`). */
  graph(): TaskGraph {
    return this.#graphOf(this.#deps.tasks.list());
  }

  /**
   * Where a task's worktree starts: the base it was given, or else what its one dependency makes
   * it (`TaskGraph.derivedBase`), worked out now and not when the task was made. `why` says, for
   * the run's error, where a derived base came from.
   */
  baseFor(task: TaskRecord): { base: string | null; why?: string } {
    if (task.baseBranch !== null) return { base: task.baseBranch };
    const derived = this.graph().derivedBase(task.id);
    if (derived.kind !== "branch") return { base: null };
    return {
      base: derived.branch,
      why: `it starts at ${derived.branch}, the branch of ${nameOf(derived.task)}, the one task it depends on, which is not done`,
    };
  }

  /** Whether the task has subtasks: then it does not run, and its status is theirs. */
  isParent(id: string): boolean {
    return this.graph().hasChildren(id);
  }

  /** By id or number. */
  find(idOrNumber: string): TaskRecord | undefined {
    return this.#deps.tasks.find(idOrNumber);
  }

  detail(id: string): BoardTaskDetail | undefined {
    const task = this.#deps.tasks.get(id);
    return task === undefined ? undefined : this.#detailOf(task);
  }

  activity(id: string): TaskActivityView[] {
    return this.#deps.tasks.activity(id);
  }

  /* ---------------------------------------------------------------- changes */

  /**
   * An agent makes a task at once (the user asked for one), executed by `assignee` when named, or
   * by the maker itself when omitted. Users create tasks through `make` (`tasks.create`), which
   * requires an explicit `assignee`. A task made here has no card, since only a confirmed draft
   * puts one in a timeline, and its first run is queued.
   */
  create(
    input: FieldsInput & {
      title: string;
      conversationId: string;
      workspace: TaskWorkspaceMode;
      /** The branch (or `#number` of another task) the worktree starts at. */
      base?: string | undefined;
      /** The agent the work is for, when that is not the maker: its name or id. */
      assignee?: string | undefined;
      captainAssignmentId?: string | null | undefined;
      captainMessageId?: string | null | undefined;
      /** What it waits for before its work starts. */
      dependsOn?: readonly DependencyInput[] | undefined;
      /** The task it is a subtask of (`#N` or id). */
      parent?: string | undefined;
      /** Atomic pre-insert hook inside the create transaction (e.g. Captain dispatch provenance). */
      beforeCreate?:
        | (() => {
            captainAssignmentId?: string | null | undefined;
            captainMessageId?: string | null | undefined;
          })
        | undefined;
      /** Atomic post-insert hook inside the create transaction once the task row has its id and number. */
      afterCreate?: ((task: TaskRecord) => void) | undefined;
    },
    actor: TaskActor,
  ): BoardTaskDetail {
    if (actor.kind !== "agent" || actor.agentId === null)
      throw new Error("only an agent makes a task");
    const { title, ...fields } = this.#fieldsOf(input);
    const { base, assignee } = input;
    if (title === undefined) throw new Error("a task needs a title");
    const conversationId = this.#conversation(input.conversationId)!;
    const conversation = this.#deps.conversations.get(conversationId);
    const project =
      conversation === undefined
        ? undefined
        : this.#deps.projects.get(conversation.projectId);
    const scope = assigneeScopeFor(conversationId, this.#deps.conversations);
    const assigneeAgent = resolveAssignee(assignee, this.#deps.agents, scope);
    if (
      assigneeAgent === undefined &&
      this.#deps.agents.get(actor.agentId)?.systemRole === "captain"
    )
      throw new Error(CAPTAIN_ASSIGNEE_ERROR);
    const executorId = assigneeAgent ?? actor.agentId;
    const executor = this.#deps.agents.get(executorId);
    if (executor !== undefined && project !== undefined)
      checkExternalAgentProject(executor, project, this.#deps.machines);
    const dependsOn = this.#dependenciesOf(input.dependsOn);
    const parent =
      input.parent === undefined || input.parent.trim() === ""
        ? undefined
        : this.#named(input.parent);
    const maker = actor.agentId;
    // The task and what it waits for are one write: a task that would start before its
    // dependencies are in place is the thing they are there to prevent.
    let moved: Moved[] = [];
    const task = this.#deps.db.transaction(() => {
      const provenance = input.beforeCreate?.();
      const made = this.#deps.tasks.create({
        ...fields,
        title,
        conversationId,
        createdByAgent: maker,
        assigneeAgent,
        captainAssignmentId:
          provenance?.captainAssignmentId ?? input.captainAssignmentId,
        captainMessageId:
          provenance?.captainMessageId ?? input.captainMessageId,
        baseBranch: base === undefined ? undefined : this.#baseOf(base),
        projectId: this.#deps.conversations.get(conversationId)?.projectId,
        workspaceMode: input.workspace,
      });
      // The parent first: what the subtask inherits is part of the cycles its edges could close.
      if (parent !== undefined) this.#setParent(made.id, parent.id, actor);
      for (const edge of dependsOn)
        this.#addEdge(made.id, edge.taskId, edge.requireDone, actor);
      if (parent !== undefined) moved = this.#deriveIn(parent.id);
      input.afterCreate?.(made);
      return made;
    })();
    this.#announce(task.id, "created", []);
    for (const edge of dependsOn) this.#announce(edge.taskId, "changed", []);
    if (parent !== undefined) this.#adopted(parent.id, moved);
    if (workable(task.status)) this.#runs?.start(task.id);
    if (parent !== undefined) this.#graphChanged();
    return this.#detailOf(this.#existing(task.id));
  }

  /**
   * The user makes tasks from the page: one, or several at once (a piece of work split into
   * subtasks). Pressing "Create" in the form is the user's confirmation, so nothing else may come
   * this way: an agent proposes, with `draft`, and the user confirms.
   *
   * Every task has an executor (an agent that exists). It works in its parent's project, else the
   * conversation's; it is discussed in the conversation given, else its parent's. A task of the
   * batch waits for the tasks it names (`dependsOn`) and for the earlier tasks of the batch it
   * points at (`after`, their indexes); it is under the task named `parent`, or under an earlier
   * task of the batch (`under`). The graph checks every edge and parent as it is written, and the
   * whole batch is one write: a refused edge leaves nothing behind.
   */
  make(
    input: {
      tasks: readonly NewTaskInput[];
      /** The task the batch goes under (`#N` or id). */
      parent?: string | undefined;
      conversationId?: string | undefined;
      /** Start once what they wait for is there, or keep them in the backlog. */
      status?: string | undefined;
      /** Where they work; absent is the parent's, else what `workspaceFor` chose for the conversation. */
      workspace?: TaskWorkspaceMode | undefined;
    },
    actor: TaskActor,
  ): BoardTaskDetail[] {
    if (actor.kind !== "user")
      throw new Error(
        "only the user makes tasks this way; an agent drafts one for the user to confirm",
      );
    if (input.tasks.length === 0) throw new Error("nothing to make");
    const { status } = this.#fieldsOf({ status: input.status ?? "todo" });
    if (status !== "todo" && status !== "backlog")
      throw new Error(`a new task starts in todo or backlog, not ${status}`);
    const parent =
      input.parent === undefined || input.parent.trim() === ""
        ? undefined
        : this.#named(input.parent);
    const conversationId =
      this.#conversation(input.conversationId) ??
      parent?.conversationId ??
      parent?.originConversationId ??
      undefined;
    const projectId =
      parent?.projectId ??
      (conversationId === undefined
        ? undefined
        : this.#deps.conversations.get(conversationId)?.projectId);
    if (projectId === undefined || projectId === null)
      throw new Error(
        "a task needs a project to work in: give it a parent, or a conversation in a project",
      );
    const workspace = input.workspace ?? parent?.workspaceMode ?? "local";
    const project = this.#deps.projects.get(projectId);
    const scope = assigneeScopeFor(conversationId, this.#deps.conversations);
    // Everything named is checked before anything is written.
    const planned = input.tasks.map((entry, index) => {
      const { title, description } = this.#fieldsOf(entry);
      if (title === undefined)
        throw new Error(`task ${index + 1} needs a title`);
      const assigneeAgent = resolveAssignee(
        entry.assignee,
        this.#deps.agents,
        scope,
      );
      if (assigneeAgent === undefined)
        throw new Error(`task ${index + 1} needs an executor`);
      const executor = this.#deps.agents.get(assigneeAgent);
      if (executor !== undefined && project !== undefined)
        checkExternalAgentProject(executor, project, this.#deps.machines);
      for (const at of [
        ...(entry.after ?? []),
        ...(entry.under === undefined ? [] : [entry.under]),
      ])
        if (!Number.isInteger(at) || at < 0 || at >= index)
          throw new Error(
            `task ${index + 1} can only point at a task before it in the batch, not ${at + 1}`,
          );
      return {
        title,
        description,
        assigneeAgent,
        dependsOn: this.#dependenciesOf(entry.dependsOn),
        after: [...new Set(entry.after ?? [])],
        under: entry.under,
        base: entry.base === undefined ? undefined : this.#baseOf(entry.base),
      };
    });
    const parents = new Set<number>(
      planned.flatMap((entry) =>
        entry.under === undefined ? [] : [entry.under],
      ),
    );
    let moved: Moved[] = [];
    const made = this.#deps.db.transaction(() => {
      const rows = planned.map((entry) =>
        this.#deps.tasks.create({
          title: entry.title,
          description: entry.description,
          status,
          assigneeAgent: entry.assigneeAgent,
          conversationId,
          projectId,
          workspaceMode: workspace,
          baseBranch: entry.base,
        }),
      );
      planned.forEach((entry, index) => {
        const id = rows[index]!.id;
        const above =
          entry.under === undefined ? parent?.id : rows[entry.under]!.id;
        if (above !== undefined) this.#setParent(id, above, actor);
      });
      planned.forEach((entry, index) => {
        const id = rows[index]!.id;
        for (const edge of entry.dependsOn)
          this.#addEdge(id, edge.taskId, edge.requireDone, actor);
        for (const at of entry.after)
          this.#addEdge(id, rows[at]!.id, false, actor);
      });
      // A task of the batch with subtasks of its own takes their status, in this same write, and
      // so does the parent the batch went under.
      moved = [
        ...[...parents].flatMap((index) => this.#deriveIn(rows[index]!.id)),
        ...(parent === undefined ? [] : this.#deriveIn(parent.id)),
      ];
      return rows;
    })();
    for (const task of made) this.#announce(task.id, "created", []);
    for (const entry of planned)
      for (const edge of entry.dependsOn)
        this.#announce(edge.taskId, "changed", []);
    if (parent !== undefined) this.#adopted(parent.id, []);
    this.#derived(moved);
    // Leaves start; a parent does not.
    made.forEach((task, index) => {
      if (!parents.has(index) && workable(task.status))
        this.#runs?.start(task.id);
    });
    this.#graphChanged();
    return made.map((task) => this.#detailOf(this.#existing(task.id)));
  }

  update(id: string, input: FieldsInput, actor: TaskActor): BoardTaskDetail {
    const before = this.#existing(id);
    const fields = this.#fieldsOf(input);
    const graph = this.graph();
    const parent =
      fields.status !== undefined &&
      fields.status !== before.status &&
      graph.hasChildren(id);
    if (
      parent &&
      fields.status !== "cancelled" &&
      before.status !== "cancelled"
    )
      throw new Error(
        `#${before.number} takes its status from its subtasks (${graph
          .childrenOf(id)
          .map((child) => `#${child.number}`)
          .join(", ")}); change theirs instead, or cancel it with all of them`,
      );
    // Cancelling a parent cancels the work under it that is not finished: it is the user saying the
    // whole of it is off.
    const cancelled =
      parent && fields.status === "cancelled"
        ? graph
            .descendantsOf(id)
            .filter((t) => t.status !== "done" && t.status !== "cancelled")
        : [];
    // Its parent takes its status again in the same write: a parent's status is a copy of what
    // its subtasks make, and a copy written apart from them is one a crash in between leaves stale.
    this.#commit(
      id,
      "changed",
      () => {
        for (const below of cancelled)
          this.#deps.tasks.update(below.id, { status: "cancelled" }, actor);
        this.#deps.tasks.update(id, fields, actor);
      },
      [before.parentId],
    );
    for (const below of cancelled) {
      this.#announce(below.id, "changed", []);
      this.#runs?.stop(
        below.id,
        `The task is cancelled with #${before.number}.`,
      );
    }
    const after = this.#existing(id);
    if (after.status !== before.status) {
      // Done or cancelled work is not worked on any more. Out of the backlog, a task that never
      // ran starts; one that has run already is rerun by hand.
      if (after.status === "done" || after.status === "cancelled") {
        this.#runs?.stop(id, `The task is ${after.status}.`);
        this.#runs?.release?.(after);
      } else if (
        workable(after.status) &&
        !workable(before.status) &&
        this.#deps.runs.ofTask(id).length === 0 &&
        !parent
      )
        this.#runs?.start(id);
      // What waits for this task reads it again, and may start, block or unblock.
      this.#statusMoved(id);
    }
    return this.#detailOf(this.#existing(id));
  }

  /* ---------------------------------------------------------------- the graph */

  /**
   * `taskId` waits for `dependsOn` (`#N` or id). An edge that is there already only has its
   * `requireDone` changed. The graph refuses what cannot be: itself, a cancelled task, a cycle.
   */
  addDependency(
    taskId: string,
    dependsOn: string,
    options: { requireDone?: boolean | undefined },
    actor: TaskActor,
  ): BoardTaskDetail {
    const task = this.#existing(taskId);
    const target = this.#named(dependsOn);
    this.#commit(task.id, "changed", () => {
      this.#addEdge(task.id, target.id, options.requireDone === true, actor);
    });
    this.#announce(target.id, "changed", []);
    this.#graphChanged();
    return this.#detailOf(this.#existing(task.id));
  }

  /** `taskId` no longer waits for `dependsOn`. A task the system blocked on it may start again. */
  removeDependency(
    taskId: string,
    dependsOn: string,
    actor: TaskActor,
  ): BoardTaskDetail {
    const task = this.#existing(taskId);
    const target = this.#named(dependsOn);
    let removed = false;
    this.#commit(task.id, "changed", () => {
      removed = this.#deps.tasks.removeDependency(task.id, target.id);
      if (removed)
        this.#deps.tasks.record(task.id, "dependency", actor, {
          data: { action: "removed", ...this.#refOf(target) },
        });
    });
    if (!removed)
      throw new Error(`#${task.number} does not wait for #${target.number}`);
    this.#announce(target.id, "changed", []);
    this.#graphChanged();
    return this.#detailOf(this.#existing(task.id));
  }

  /**
   * Make the task a subtask of `parent` (`#N` or id), or of none (null). The graph refuses a parent
   * that is the task or under it, or one that would close a cycle. The parent stops running if this
   * is its first subtask, and both the old parent and the new one take their status again.
   */
  setParent(
    taskId: string,
    parent: string | null,
    actor: TaskActor,
  ): BoardTaskDetail {
    const task = this.#existing(taskId);
    const next =
      parent === null || parent.trim() === "" ? null : this.#named(parent);
    const before = task.parentId;
    if ((next?.id ?? null) === before) return this.#detailOf(task);
    // Both parents take their status again in the same write.
    this.#commit(
      task.id,
      "changed",
      () => {
        this.#setParent(task.id, next?.id ?? null, actor);
      },
      [next?.id ?? null, before],
    );
    for (const other of [before, next?.id ?? null])
      if (other !== null) this.#announce(other, "changed", []);
    if (next !== null) this.#adopted(next.id, []);
    this.#graphChanged();
    return this.#detailOf(this.#existing(task.id));
  }

  /**
   * A queued run of the task found something it waits for cancelled (the runner asks, in `pump`):
   * the task cannot start on its own, so it is blocked, saying which dependency and that the user
   * decides, and the runs that would start it are withdrawn. Nothing happens when the graph does
   * not say broken. The status carries the mark that lets the system undo it (`#settle`).
   */
  blockOnCancelled(taskId: string): void {
    const task = this.#deps.tasks.get(taskId);
    if (task === undefined) return;
    const gate = this.graph().gate(taskId);
    if (gate.state !== "broken") return;
    const system: TaskActor = { kind: "system", agentId: null };
    this.#commit(
      taskId,
      "changed",
      () => {
        for (const cancelled of gate.cancelled)
          this.#deps.tasks.record(taskId, "dependency", system, {
            data: { action: "blocked", ...this.#refOf(cancelled) },
          });
        if (task.status !== "blocked")
          this.#deps.tasks.update(
            taskId,
            { status: "blocked", statusReason: DEPENDENCY_CANCELLED },
            system,
          );
      },
      [task.parentId],
    );
    // The run ends with no words: the `blocked` entry above says why, in the reader's language.
    this.#runs?.withdraw(taskId);
  }

  /**
   * Comment on a task. A comment that is not the executor's own words (a run's tools say so with
   * `deliver: false`) is also handed to the run that is going, which carries on with it, and to the
   * agents it `mentions` (ids, kept in its data). `wake: false` hands it only to a run that is
   * going. A retry with the same client id is the same comment and is delivered once.
   */
  comment(
    id: string,
    body: string,
    actor: TaskActor,
    options: {
      clientId?: string | undefined;
      deliver?: boolean;
      wake?: boolean;
      mentions?: readonly string[];
      /** Files uploaded for this task (`tasks.attach`), by id: the comment claims them. */
      attachments?: readonly string[];
    } = {},
  ): { task: BoardTaskDetail; activity: TaskActivityView } {
    const { clientId } = options;
    const mentions = [...new Set(options.mentions ?? [])];
    const task = this.#existing(id);
    const fileIds = options.attachments ?? [];
    if (body.trim() === "" && fileIds.length === 0)
      throw new Error("a comment needs some text");
    this.#checkMentions(task, mentions);
    // A retry with the same client id is the same comment: hand back the one already there.
    const earlier =
      clientId === undefined
        ? undefined
        : this.#deps.tasks.commentByClientId(id, clientId);
    if (earlier !== undefined)
      return { task: this.#detailOf(this.#existing(id)), activity: earlier };
    let activity!: TaskActivityView;
    this.#commit(id, "changed", () => {
      const store = this.#deps.attachments;
      if (fileIds.length > 0 && store === undefined)
        throw new Error("this host takes no files with a comment");
      const files =
        fileIds.length === 0 ? [] : store!.check({ taskId: id }, fileIds);
      const data = {
        ...(clientId === undefined ? {} : { clientId }),
        ...(mentions.length === 0 ? {} : { mentions }),
        ...(files.length === 0
          ? {}
          : { attachments: files.map(attachmentView) }),
      };
      activity = this.#deps.tasks.record(id, "comment", actor, {
        body,
        data: Object.keys(data).length === 0 ? undefined : data,
      })!;
      if (files.length > 0)
        store!.claim(
          files.map((file) => file.id),
          activity.id,
        );
    });
    if (options.deliver !== false)
      this.#runs?.deliver(id, activity, { wake: options.wake !== false });
    return { task: this.#detailOf(this.#existing(id)), activity };
  }

  /** Link the task to a conversation, or (null) take the link away. */
  link(
    id: string,
    conversationId: string | null,
    actor: TaskActor,
  ): BoardTaskDetail {
    this.#existing(id);
    const target = this.#conversation(conversationId ?? undefined) ?? null;
    this.#commit(id, "changed", () => {
      this.#deps.tasks.update(id, { conversationId: target }, actor);
    });
    return this.#detailOf(this.#existing(id));
  }

  /**
   * Delete a task. Its cards stay in the timelines they are in, and say it is gone. What waited
   * for it no longer does (the edges go with it), and each of those says so on its timeline.
   */
  remove(id: string): void {
    const task = this.#existing(id);
    if (this.#runs?.active(id) === true)
      throw new Error("a run is working on this task; stop it before deleting");
    const graph = this.graph();
    const waiting = graph.dependentsOf(id).map((edge) => edge.taskId);
    const awaited = graph.dependenciesOf(id).map((edge) => edge.dependsOnId);
    const children = graph.childrenOf(id);
    this.#deps.db.transaction(() => {
      // Its subtasks stay, with no parent: they say so, and so does the parent it was under.
      for (const child of children)
        this.#commit(child.id, "changed", () => {
          this.#deps.tasks.record(child.id, "parent", SYSTEM, {
            data: { from: this.#refOf(task), to: null, deleted: true },
          });
        });
      if (task.parentId !== null)
        this.#commit(task.parentId, "changed", () => {
          this.#deps.tasks.record(task.parentId!, "subtask", SYSTEM, {
            data: { action: "deleted", ...this.#refOf(task) },
          });
        });
      for (const dependent of waiting)
        this.#commit(dependent, "changed", () => {
          this.#deps.tasks.record(
            dependent,
            "dependency",
            { kind: "system", agentId: null },
            { data: { action: "deleted", ...this.#refOf(task) } },
          );
        });
      this.#commit(
        id,
        "removed",
        () => {
          this.#deps.tasks.remove(id);
        },
        [task.parentId],
      );
    })();
    for (const other of awaited) this.#announce(other, "changed", []);
    this.#graphChanged();
    void this.#deps.attachments?.dropTask(id).catch(() => undefined);
    this.#runs?.release?.(task);
  }

  /**
   * The images a comment carried were not shown to `agentId`: its model takes none, and it was
   * given them as files. The comment says so from then on, for the user to see.
   */
  imagesUnseen(taskId: string, activityId: string, agentId: string): void {
    const entry = this.#deps.tasks
      .activity(taskId)
      .find((item) => item.id === activityId);
    if (entry === undefined) return;
    const by = Array.isArray(entry.data.imagesUnseenBy)
      ? (entry.data.imagesUnseenBy as string[])
      : [];
    if (by.includes(agentId)) return;
    this.#commit(taskId, "changed", () => {
      this.#deps.tasks.annotate(activityId, {
        imagesUnseenBy: [...by, agentId],
      });
    });
  }

  /** An artifact was published for the task: it goes on the task's timeline and into its cards. */
  artifactPublished(
    taskId: string,
    artifact: TaskArtifactRef,
    actor: TaskActor,
  ): void {
    this.#existing(taskId);
    this.#commit(taskId, "changed", () => {
      this.#deps.tasks.record(taskId, "artifact", actor, {
        data: { ...artifact },
      });
    });
  }

  /** The task's artifacts changed in a way that has no entry of its own (one was deleted). */
  artifactsChanged(taskId: string): void {
    if (this.#deps.tasks.get(taskId) === undefined) return;
    this.#commit(taskId, "changed", () => undefined);
  }

  /* ---------------------------------------------------------------- archiving */

  /**
   * Put a task away, and its subtasks with it: a parent is never archived with work under it still
   * on the board. Any status may be; a task whose tree has a run that has not ended is refused
   * unless `stopRuns`, which stops them first, the way a cancel does. The runs that were going end
   * after the task is archived, and their ends do not bring it back (`TaskStore`). Who did it is
   * on each timeline. A task archived already is left as it is.
   */
  archive(
    id: string,
    actor: TaskActor,
    options: { stopRuns?: boolean | undefined } = {},
  ): BoardTaskDetail {
    const task = this.#existing(id);
    const tree = this.#archivable(task);
    if (tree.length === 0) return this.#detailOf(task);
    const running = tree.filter((t) => this.#deps.runs.openOf(t.id).length > 0);
    if (running.length > 0 && options.stopRuns !== true)
      throw new Error(
        `${running.map((t) => `#${t.number}`).join(", ")} ${running.length === 1 ? "has a run" : "have runs"} that has not ended; archiving stops ${running.length === 1 ? "it" : "them"} (stopRuns)`,
      );
    const stopped = new Map<string, string[]>();
    for (const t of running) {
      stopped.set(
        t.id,
        this.#deps.runs.openOf(t.id).map((run) => run.id),
      );
      this.#runs?.stop(t.id, "The task is archived.");
    }
    const by =
      actor.kind === "agent" && actor.agentId !== null ? actor.agentId : "user";
    this.#deps.db.transaction(() => {
      for (const t of tree)
        this.#commit(t.id, "changed", () => {
          this.#deps.tasks.archive(t.id, by, actor, {
            reason: "manual",
            stoppedRuns: (stopped.get(t.id) ?? []).filter(
              // A queued run ended as it was stopped; only one that was going ends later.
              (runId) => this.#deps.runs.get(runId)?.finishedAt === null,
            ),
            ...(t.id === task.id ? {} : { with: this.#refOf(task) }),
          });
        });
    })();
    for (const t of tree) this.#runs?.release?.(this.#existing(t.id));
    return this.#detailOf(this.#existing(task.id));
  }

  /**
   * What archiving the task would have to stop: the tasks of its tree, not archived yet, with a run
   * that has not ended. `archive` refuses these unless `stopRuns`; this asks first, without trying.
   */
  runningIfArchived(id: string): TaskRecord[] {
    return this.#archivable(this.#existing(id)).filter(
      (t) => this.#deps.runs.openOf(t.id).length > 0,
    );
  }

  /** The task and everything under it that is not archived yet: what `archive` puts away. */
  #archivable(task: TaskRecord): TaskRecord[] {
    return [
      task,
      ...this.graph()
        .descendantsOf(task.id)
        .map((t) => this.#existing(t.id)),
    ].filter((t) => t.archivedAt === null || t.archivedAt === undefined);
  }

  /** Bring tasks back to the board, each with its archived subtasks. */
  unarchive(ids: readonly string[], actor: TaskActor): BoardTaskDetail[] {
    const roots = ids.map((id) => this.#named(id));
    const graph = this.graph();
    this.#deps.db.transaction(() => {
      for (const root of roots)
        for (const t of [
          root,
          ...graph.descendantsOf(root.id).map((d) => this.#existing(d.id)),
        ]) {
          const now = this.#existing(t.id);
          if (now.archivedAt === null || now.archivedAt === undefined) continue;
          this.#commit(t.id, "changed", () => {
            this.#deps.tasks.unarchive(t.id, actor, {
              cause: "manual",
              ...(t.id === root.id ? {} : { with: this.#refOf(root) }),
            });
          });
        }
    })();
    return roots.map((root) => this.#detailOf(this.#existing(root.id)));
  }

  /**
   * The host puts away what is finished and quiet: a done or cancelled task, not archived, whose
   * timeline has had nothing new for `days` days and that has no run left going. A parent goes
   * only once everything under it would too (or is away already), and then the whole tree goes
   * together. Returns the tasks it archived.
   */
  archiveStale(days: number, now: number = Date.now()): string[] {
    const cutoff = now - days * DAY;
    const tasks = this.#deps.tasks.list();
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const graph = this.#graphOf(tasks);
    const last = this.#deps.tasks.lastActivity();
    const isArchived = (task: TaskRecord): boolean =>
      task.archivedAt !== null && task.archivedAt !== undefined;
    const ready = new Map<string, boolean>();
    const readyOf = (task: TaskRecord): boolean => {
      const known = ready.get(task.id);
      if (known !== undefined) return known;
      ready.set(task.id, false);
      const answer =
        isArchived(task) ||
        (finished(task.status) &&
          (last.get(task.id) ?? task.updatedAt) < cutoff &&
          this.#deps.runs.openOf(task.id).length === 0 &&
          graph
            .childrenOf(task.id)
            .every((child) => readyOf(byId.get(child.id)!)));
      ready.set(task.id, answer);
      return answer;
    };
    const chosen = tasks.filter((task) => !isArchived(task) && readyOf(task));
    if (chosen.length === 0) return [];
    // The top of each tree that goes, so a subtask can say which one it went with.
    const topOf = (task: TaskRecord): TaskRecord => {
      let at = task;
      while (at.parentId !== null) {
        const parent = byId.get(at.parentId);
        if (parent === undefined || isArchived(parent) || !readyOf(parent))
          break;
        at = parent;
      }
      return at;
    };
    this.#deps.db.transaction(() => {
      for (const task of chosen) {
        const top = topOf(task);
        this.#commit(task.id, "changed", () => {
          this.#deps.tasks.archive(
            task.id,
            "auto",
            SYSTEM,
            {
              reason: "stale",
              days,
              ...(top.id === task.id ? {} : { with: this.#refOf(top) }),
            },
            now,
          );
        });
      }
    })();
    for (const task of chosen) this.#runs?.release?.(task);
    return chosen.map((task) => task.id);
  }

  /* ---------------------------------------------------------------- runs */

  /**
   * Something happened to a run of the task: it goes on the timeline and into the cards, and the
   * board is told. `kind` is absent when the run changed in a way the timeline has no entry for
   * (it started waiting for a different reason, it is going now).
   */
  runEvent(
    taskId: string,
    event?: {
      kind: TaskActivityKind;
      runId: string;
      body?: string | undefined;
      data?: Record<string, unknown> | undefined;
      actor?: TaskActor | undefined;
    },
  ): void {
    if (this.#deps.tasks.get(taskId) === undefined) return;
    this.#commit(taskId, "changed", () => {
      if (event === undefined) return;
      this.#deps.tasks.record(
        taskId,
        event.kind,
        event.actor ?? { kind: "system", agentId: null },
        {
          runId: event.runId,
          ...(event.body === undefined ? {} : { body: event.body }),
          ...(event.data === undefined ? {} : { data: event.data }),
        },
      );
    });
  }

  /** The worktree a run made for the task. */
  /** The workspace a task's new subtasks get: its own (`make` with this parent). */
  workspaceOf(task: string): TaskWorkspaceMode {
    return this.#named(task).workspaceMode;
  }

  setWorktree(id: string, path: string, branch: string): void {
    this.#deps.tasks.setWorktree(id, path, branch);
    this.#commit(id, "changed", () => undefined);
  }

  /* ---------------------------------------------------------------- drafts */

  /**
   * A base a task names, resolved: `#N` is that task's `eta/task-<N>` branch, so one task can
   * build on another. A branch or commit is kept as written; an empty base is none at all.
   */
  #baseOf(base: string): string {
    const trimmed = base.trim();
    if (trimmed === "") return "";
    const mentioned = /^#?(\d+)$/.exec(trimmed);
    if (mentioned !== null) return `eta/task-${mentioned[1]}`;
    return trimmed;
  }

  /**
   * An agent proposes work in the conversation it is in; the user decides. What it would wait for
   * is resolved to ids and checked now, so the agent hears what is wrong while it can fix it.
   */
  draft(input: {
    conversationId: string;
    agentId: string;
    draft: Omit<DraftInput, "dependsOn" | "parentId"> & {
      dependsOn?: readonly DependencyInput[] | undefined;
      /** The task it would be a subtask of (`#N` or id). */
      parent?: string | undefined;
    };
  }): MessageView {
    const dependsOn = this.#dependenciesOf(input.draft.dependsOn);
    const { parent: named, ...draft } = input.draft;
    const parent =
      named === undefined || named.trim() === ""
        ? undefined
        : this.#named(named);
    const row = this.#deps.cards.draft({
      ...input,
      draft: {
        ...draft,
        base: draft.base === undefined ? undefined : this.#baseOf(draft.base),
        dependsOn: dependsOn.length === 0 ? undefined : dependsOn,
        parentId: parent?.id,
      },
    });
    this.#deps.changed([input.conversationId]);
    return row;
  }

  /** The user confirms a draft, perhaps edited. Confirming again returns the same task. */
  confirmDraft(input: {
    conversationId: string;
    messageId: string;
    edits?: FieldsInput | undefined;
    /** The host confirms it, after the draft waited this many minutes; the user did not. */
    auto?: { minutes: number } | undefined;
  }): { task: BoardTaskDetail; message: MessageView } {
    // The draft's dependencies were checked when it was drafted; much can change before it is
    // confirmed, so they are checked again here, in the same write that makes the task.
    const { task, message, created, dependsOn, moved } =
      this.#deps.db.transaction(() => {
        const confirmed = this.#deps.cards.confirm({
          conversationId: input.conversationId,
          messageId: input.messageId,
          fields: this.#fieldsOf(input.edits ?? {}),
          auto: input.auto === undefined ? undefined : "timeout",
        });
        const edges = confirmed.created ? confirmed.dependsOn : [];
        const actor: TaskActor =
          input.auto === undefined ? { kind: "user", agentId: null } : SYSTEM;
        if (confirmed.created && input.auto !== undefined)
          this.#deps.tasks.record(confirmed.task.id, "comment", SYSTEM, {
            body: `Accepted automatically: the draft waited ${input.auto.minutes} minute(s) without a decision.`,
          });
        if (confirmed.created && confirmed.parentId !== undefined)
          this.#setParent(confirmed.task.id, confirmed.parentId, actor);
        for (const edge of edges)
          this.#addEdge(
            confirmed.task.id,
            edge.taskId,
            edge.requireDone,
            actor,
          );
        // The parent takes its status again in the same write.
        const moved =
          confirmed.created && confirmed.parentId !== undefined
            ? this.#deriveIn(confirmed.parentId)
            : [];
        return { ...confirmed, dependsOn: edges, moved };
      })();
    if (created) {
      this.#announce(task.id, "created", [input.conversationId]);
      for (const edge of dependsOn) this.#announce(edge.taskId, "changed", []);
      const parentId = this.#existing(task.id).parentId;
      if (parentId !== null) this.#adopted(parentId, moved);
      if (workable(task.status)) this.#runs?.start(task.id);
      if (parentId !== null) this.#graphChanged();
    }
    return { task: this.#detailOf(this.#existing(task.id)), message };
  }

  /** The user discards a draft: no task is made and the card says so. */
  discardDraft(input: {
    conversationId: string;
    messageId: string;
    /** The host discards it, not the user. */
    auto?: "timeout" | undefined;
  }): {
    message: MessageView;
  } {
    const message = this.#deps.cards.discard(input);
    this.#deps.changed([input.conversationId]);
    return { message };
  }

  /**
   * The host's own decision for drafts that waited too long: every draft still pending that was
   * written at or before `cutoff` is confirmed as it stands or discarded. One the host cannot
   * confirm (a dependency changed, say) stays pending, keeps the reason, and is not tried again.
   */
  settleExpiredDrafts(input: {
    cutoff: number;
    action: TaskDraftTimeoutAction;
    minutes: number;
  }): { settled: string[]; failed: { messageId: string; error: string }[] } {
    const settled: string[] = [];
    const failed: { messageId: string; error: string }[] = [];
    for (const row of this.#deps.cards.pendingBefore(input.cutoff)) {
      if (row.data.autoFailure !== undefined) continue;
      const target = { conversationId: row.conversationId, messageId: row.id };
      try {
        if (input.action === "accept")
          this.confirmDraft({ ...target, auto: { minutes: input.minutes } });
        else this.discardDraft({ ...target, auto: "timeout" });
        settled.push(row.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#deps.cards.failAuto(row.id, reason);
        this.#deps.changed([row.conversationId]);
        failed.push({ messageId: row.id, error: reason });
      }
    }
    return { settled, failed };
  }

  /* ---------------------------------------------------------------- inside */

  #graphOf(tasks: readonly TaskRecord[]): TaskGraph {
    return new TaskGraph(
      tasks.map(graphTaskOf),
      this.#deps.tasks.dependencies(),
    );
  }

  /** A task another one names: by `#N` or id. */
  #named(idOrNumber: string): TaskRecord {
    const task = this.#deps.tasks.find(idOrNumber.trim());
    if (task === undefined) throw new Error(`no such task: ${idOrNumber}`);
    return task;
  }

  /** The other end of an edge, as a timeline entry keeps it. */
  #refOf(
    task: Pick<GraphTask, "id" | "number" | "title">,
  ): Record<string, unknown> {
    return { taskId: task.id, number: task.number, title: task.title };
  }

  /** Dependencies a caller named, found and with no task named twice; checked when added. */
  #dependenciesOf(
    input: readonly DependencyInput[] | undefined,
  ): { taskId: string; requireDone: boolean }[] {
    const found = new Map<string, boolean>();
    for (const dependency of input ?? []) {
      const task = this.#named(dependency.task);
      found.set(
        task.id,
        (found.get(task.id) ?? false) || dependency.requireDone === true,
      );
    }
    // A task waiting for a cancelled one is refused before anything is made, not after.
    const graph = this.graph();
    for (const id of found.keys()) {
      const task = graph.task(id)!;
      if (task.status === "cancelled")
        throw new Error(
          `${nameOf(task)} is cancelled, so nothing can wait for it`,
        );
    }
    return [...found].map(([taskId, requireDone]) => ({ taskId, requireDone }));
  }

  /**
   * Add or change one edge, inside the caller's write: the graph checks it as things are in that
   * write, so a cycle cannot slip in between the check and the row.
   */
  #addEdge(
    taskId: string,
    dependsOnId: string,
    requireDone: boolean,
    actor: TaskActor,
  ): void {
    this.graph().checkEdge(taskId, dependsOnId);
    const target = this.#existing(dependsOnId);
    const before = this.#deps.tasks.setDependency(
      taskId,
      dependsOnId,
      requireDone,
    );
    if (before !== undefined && before.requireDone === requireDone) return;
    this.#deps.tasks.record(taskId, "dependency", actor, {
      data: {
        action: before === undefined ? "added" : "required",
        ...this.#refOf(target),
        requireDone,
      },
    });
  }

  /**
   * A task's status moved: the tasks that wait for it read it again, and the graph settles. Its
   * parent moved with it, in the same write.
   */
  #statusMoved(id: string): void {
    for (const edge of this.graph().dependentsOf(id))
      this.#announce(edge.taskId, "changed", []);
    this.#graphChanged();
  }

  /**
   * Make `taskId` a subtask of `parentId` (or of none), inside the caller's write: the graph checks
   * it as things are in that write. The subtask and both parents say so on their timelines.
   */
  #setParent(taskId: string, parentId: string | null, actor: TaskActor): void {
    const graph = this.graph();
    const task = graph.task(taskId)!;
    if (parentId !== null) graph.checkParent(taskId, parentId);
    const from = task.parentId === null ? undefined : graph.task(task.parentId);
    const to = parentId === null ? undefined : graph.task(parentId);
    this.#deps.tasks.setParent(taskId, parentId);
    this.#deps.tasks.record(taskId, "parent", actor, {
      data: {
        from: from === undefined ? null : this.#refOf(from),
        to: to === undefined ? null : this.#refOf(to),
      },
    });
    if (from !== undefined)
      this.#deps.tasks.record(from.id, "subtask", actor, {
        data: { action: "removed", ...this.#refOf(task) },
      });
    if (to !== undefined)
      this.#deps.tasks.record(to.id, "subtask", actor, {
        data: { action: "added", ...this.#refOf(task) },
      });
    if (from !== undefined) this.#deps.cards.sync(from.id);
    if (to !== undefined) this.#deps.cards.sync(to.id);
  }

  /**
   * A task got a subtask: it does not start its own work any more (a run that would has not
   * started yet is withdrawn; one that is going, such as an executor splitting its task, goes on).
   * It took its status from its subtasks in the write that gave it one: `moved` is what that
   * write moved, told now.
   */
  #adopted(parentId: string, moved: readonly Moved[]): void {
    // No words of its own: the `subtask` entry next to it says why, in the reader's language.
    this.#runs?.withdraw(parentId, "executor");
    this.#derived(moved);
  }

  /**
   * A parent takes the status its subtasks make (`TaskGraph.derive`), and its parent then does the
   * same, up the tree while anything changes. A cancelled parent is left alone: that was the
   * user's word on the whole of it. Its timeline says the system moved it, and why.
   *
   * This writes inside the caller's write, the one that changed the subtask: the parent's status is
   * a copy of what its subtasks make, and a copy written apart from them is one a crash in between
   * leaves stale (the startup `reconcile` is the net under that). What it moved is told once the
   * write is in (`#derived`).
   */
  #deriveIn(id: string | null): Moved[] {
    const moved: Moved[] = [];
    let at = id;
    while (at !== null) {
      const task = this.#deps.tasks.get(at);
      if (task === undefined || task.status === "cancelled") break;
      const derived = this.graph().derive(at);
      if (derived === undefined || derived.status === task.status) break;
      if (derived.reason === "all_cancelled")
        this.#deps.tasks.record(task.id, "subtask", SYSTEM, {
          data: { action: "all_cancelled" },
        });
      this.#deps.tasks.update(
        task.id,
        { status: derived.status, statusReason: derived.reason },
        SYSTEM,
      );
      moved.push({
        id: task.id,
        status: derived.status,
        touched: this.#deps.cards.sync(task.id),
      });
      at = task.parentId;
    }
    return moved;
  }

  /** Parents moved in a write that is in: the board hears of them, and so does what waits for them. */
  #derived(moved: readonly Moved[]): void {
    for (const { id, status, touched } of moved) {
      this.#announce(id, "changed", touched);
      if (status === "done")
        this.#runs?.stop(id, "The task is done: all of its subtasks are.");
      for (const edge of this.graph().dependentsOf(id))
        this.#announce(edge.taskId, "changed", []);
    }
  }

  /**
   * Every parent's status made again from its subtasks, deepest first so a parent reads its
   * subtasks as corrected. The host does it as it starts, before any run: a process that died
   * between a subtask's write and its parent's (an older one, which made them two writes) left the
   * parent stale, and so everything waiting for it. A parent whose stored status was not what its
   * subtasks make is moved, with `recomputed` on its status entry; a cancelled one is left alone,
   * as always. Returns the ids corrected.
   */
  reconcile(): string[] {
    const moved = this.#deps.db.transaction(() => {
      const out: Moved[] = [];
      let graph = this.graph();
      const depth = (id: string) => graph.ancestorsOf(id).length;
      const parents = this.#deps.tasks
        .list()
        .filter((task) => graph.hasChildren(task.id))
        .map((task) => task.id)
        .sort((a, b) => depth(b) - depth(a));
      for (const id of parents) {
        const task = this.#deps.tasks.get(id);
        if (task === undefined || task.status === "cancelled") continue;
        const derived = graph.derive(id);
        if (derived === undefined || derived.status === task.status) continue;
        this.#deps.tasks.update(
          id,
          { status: derived.status, statusReason: RECOMPUTED },
          SYSTEM,
        );
        out.push({
          id,
          status: derived.status,
          touched: this.#deps.cards.sync(id),
        });
        graph = this.graph();
      }
      return out;
    })();
    this.#derived(moved);
    if (moved.length > 0) this.#graphChanged();
    return moved.map((entry) => entry.id);
  }

  /** The graph changed: the system's own blocks that no longer hold are undone, and the queue is looked at again. */
  #graphChanged(): void {
    this.#settle();
    this.#runs?.pump();
  }

  /**
   * Undo the blocks the system made itself (`blockOnCancelled`) whose cause is gone: the
   * dependency was removed, or the task it waited for is not cancelled any more. Such a task goes
   * back to `todo` and asks for its first run again, which waits, if it must, like any other. A
   * task someone else blocked (the user, its executor) stays blocked: that is theirs to undo.
   */
  #settle(): void {
    if (this.#settling) return;
    this.#settling = true;
    try {
      const system: TaskActor = { kind: "system", agentId: null };
      for (const task of this.#deps.tasks.list()) {
        if (task.status !== "blocked") continue;
        const last = this.#deps.tasks.lastStatusEntry(task.id);
        if (last?.data.reason !== DEPENDENCY_CANCELLED) continue;
        if (this.graph().gate(task.id).state === "broken") continue;
        this.#commit(
          task.id,
          "changed",
          () => {
            this.#deps.tasks.record(task.id, "dependency", system, {
              data: { action: "unblocked" },
            });
            this.#deps.tasks.update(task.id, { status: "todo" }, system);
          },
          [task.parentId],
        );
        this.#runs?.start(task.id);
      }
    } finally {
      this.#settling = false;
    }
  }

  /**
   * A change, the refresh of the task's cards in the same write, and then the news of it. The
   * parents named in `derive` take their status again in that same write (`#deriveIn`).
   */
  #commit(
    id: string,
    kind: BoardChange["kind"],
    work: () => void,
    derive: readonly (string | null)[] = [],
  ): void {
    let touched: string[] = [];
    let moved: Moved[] = [];
    this.#deps.db.transaction(() => {
      work();
      touched = this.#deps.cards.sync(id);
      moved = derive.flatMap((parent) => this.#deriveIn(parent));
    })();
    this.#announce(id, kind, touched);
    this.#derived(moved);
  }

  #announce(
    taskId: string,
    kind: BoardChange["kind"],
    conversations: readonly string[],
  ): void {
    if (conversations.length > 0) this.#deps.changed(conversations);
    for (const listener of this.#listeners) listener({ taskId, kind });
  }

  #detailOf(task: TaskRecord): BoardTaskDetail {
    const {
      description,
      projectId,
      workspaceMode,
      baseBranch,
      worktreePath,
      worktreeBranch,
      originConversationId,
    } = task;
    const graph = this.graph();
    return {
      ...viewOf(task, graph),
      description,
      projectId,
      originConversationId,
      workspace: {
        mode: workspaceMode,
        base: baseBranch ?? this.baseFor(task).base,
        path: worktreePath,
        branch: worktreeBranch,
      },
      artifacts: this.#deps.artifactsOf(task.id),
      runs: this.#deps.runs.ofTask(task.id).map(({ taskId: _, ...run }) => run),
      dependents: graph
        .dependentsOf(task.id)
        .map((edge) => endOf(graph, edge, edge.taskId)),
      children: graph.childrenOf(task.id).map(refOf),
      ancestors: graph.ancestorsOf(task.id).reverse().map(refOf),
    };
  }

  /**
   * A task that came from a group is that group's work: only its members can be called into the
   * thread. One from Captain's own conversation, or from nowhere, can call in any agent.
   */
  #checkMentions(task: TaskRecord, mentions: readonly string[]): void {
    if (mentions.length === 0) return;
    const project =
      task.projectId === null
        ? undefined
        : this.#deps.projects.get(task.projectId);
    if (project !== undefined) {
      for (const agentId of mentions) {
        const mentionedAgent = this.#deps.agents.get(agentId);
        if (mentionedAgent !== undefined)
          checkExternalAgentProject(
            mentionedAgent,
            project,
            this.#deps.machines,
          );
      }
    }
    if (task.originConversationId === null) return;
    const origin = this.#deps.conversations.get(task.originConversationId);
    if (origin?.kind !== "group") return;
    const members = new Set(
      this.#deps.conversations
        .participants(origin.id)
        .map((member) => member.agentId),
    );
    const outside = mentions.filter((agentId) => !members.has(agentId));
    if (outside.length > 0)
      throw new Error(
        `only members of the group "${origin.name}" can be mentioned on this task (not: ${outside.join(", ")})`,
      );
  }

  #existing(id: string): TaskRecord {
    const task = this.#deps.tasks.get(id);
    if (task === undefined) throw new Error(`no such task: ${id}`);
    return task;
  }

  #conversation(id: string | undefined): string | undefined {
    if (id === undefined) return undefined;
    if (this.#deps.conversations.get(id) === undefined)
      throw new Error(`no such conversation: ${id}`);
    return id;
  }

  /** Check what came from outside. A field left out stays out; one that is wrong is refused. */
  #fieldsOf(input: FieldsInput): Fields {
    const fields: Fields = {};
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title === "") throw new Error("a task needs a title");
      fields.title = title;
    }
    if (input.description !== undefined) fields.description = input.description;
    if (input.status !== undefined) {
      if (!(TASK_STATUSES as readonly string[]).includes(input.status)) {
        throw new Error(
          `status must be one of ${TASK_STATUSES.join(", ")}, not ${input.status}`,
        );
      }
      fields.status = input.status as BoardTaskStatus;
    }
    return fields;
  }
}
