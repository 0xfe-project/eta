import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  MessageView,
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskArtifactRef,
  TaskDependencyView,
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
import type { ConversationStore } from "../conversations/store";
import type { DraftInput, TaskCards } from "./cards";
import type { GraphEdge, GraphTask } from "./graph";
import type { TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import { TASK_STATUSES } from "@eta/client-contracts";
import { resolveAssignee } from "./assignee";
import { nameOf, TaskGraph } from "./graph";

/** A dependency as a caller names it: the task (`#N` or id), and whether only done resolves it. */
export interface DependencyInput {
  task: string;
  requireDone?: boolean | undefined;
}

/** What the system writes on a status it set because a dependency was cancelled. */
const DEPENDENCY_CANCELLED = "dependency_cancelled";

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
  /** Whether a run of the task is starting or going. */
  active: (taskId: string) => boolean;
  /**
   * The runs that would start the task's work and have not started (its first run, a rerun)
   * are withdrawn: they end interrupted, with no words of their own, since the board's entry
   * says why. Runs already going, and the runs of comments and mentions, are left alone.
   */
  withdraw: (taskId: string) => void;
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

/**
 * Whether a task in this status is one an executor works on. It answers two questions at once: does
 * a change to this task set a run going, and does a comment on it wake one. A task in the backlog is
 * not claimed yet, and one that is done or cancelled has nothing more to do with it: those comments
 * are recorded and read by whoever looks.
 */
export const workable = (status: BoardTaskStatus): boolean =>
  status !== "backlog" && status !== "done" && status !== "cancelled";

export interface TaskBoardDeps {
  db: Database;
  tasks: TaskStore;
  runs: TaskRunStore;
  cards: TaskCards;
  conversations: ConversationStore;
  /** Who an assignee is: the caller names it, the task keeps the registry's id. */
  agents: Pick<AgentStore, "get" | "list">;
  /** The newest version of each artifact published for a task. */
  artifactsOf: (taskId: string) => TaskArtifactRef[];
  /** These conversations' timelines moved. */
  changed: (conversationIds: readonly string[]) => void;
}

/** A task as the graph needs it. */
const graphTaskOf = (task: TaskRecord): GraphTask => ({
  id: task.id,
  number: task.number,
  title: task.title,
  status: task.status,
  projectId: task.projectId,
  workspaceMode: task.workspaceMode,
});

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
  captainAssignmentId: task.captainAssignmentId,
  captainMessageId: task.captainMessageId,
  runStatus: task.runStatus,
  dependsOn: dependsOnOf(graph, task.id),
  comments: task.comments,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

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

  list(): BoardTaskView[] {
    const tasks = this.#deps.tasks.list();
    const graph = this.#graphOf(tasks);
    return tasks.map((task) => viewOf(task, graph));
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
   * An agent makes a task at once (the user asked for one). Users do not make tasks: the one who
   * makes a task is the one who executes it. A task made this way has no card, since only a
   * confirmed draft puts one in a timeline, and its first run is queued.
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
    },
    actor: TaskActor,
  ): BoardTaskDetail {
    if (actor.kind !== "agent" || actor.agentId === null)
      throw new Error("only an agent makes a task");
    const { title, ...fields } = this.#fieldsOf(input);
    const { base, assignee } = input;
    if (title === undefined) throw new Error("a task needs a title");
    const assigneeAgent = resolveAssignee(assignee, this.#deps.agents);
    const conversationId = this.#conversation(input.conversationId)!;
    const dependsOn = this.#dependenciesOf(input.dependsOn);
    const maker = actor.agentId;
    // The task and what it waits for are one write: a task that would start before its
    // dependencies are in place is the thing they are there to prevent.
    const task = this.#deps.db.transaction(() => {
      const made = this.#deps.tasks.create({
        ...fields,
        title,
        conversationId,
        createdByAgent: maker,
        assigneeAgent,
        captainAssignmentId: input.captainAssignmentId,
        captainMessageId: input.captainMessageId,
        baseBranch: base === undefined ? undefined : this.#baseOf(base),
        projectId: this.#deps.conversations.get(conversationId)?.projectId,
        workspaceMode: input.workspace,
      });
      for (const edge of dependsOn)
        this.#addEdge(made.id, edge.taskId, edge.requireDone, actor);
      return made;
    })();
    this.#announce(task.id, "created", []);
    for (const edge of dependsOn) this.#announce(edge.taskId, "changed", []);
    if (workable(task.status)) this.#runs?.start(task.id);
    return this.#detailOf(this.#existing(task.id));
  }

  update(id: string, input: FieldsInput, actor: TaskActor): BoardTaskDetail {
    const before = this.#existing(id);
    const fields = this.#fieldsOf(input);
    this.#commit(id, "changed", () => {
      this.#deps.tasks.update(id, fields, actor);
    });
    const after = this.#existing(id);
    if (after.status !== before.status) {
      // Done or cancelled work is not worked on any more. Out of the backlog, a task that never
      // ran starts; one that has run already is rerun by hand.
      if (after.status === "done" || after.status === "cancelled")
        this.#runs?.stop(id, `The task is ${after.status}.`);
      else if (
        workable(after.status) &&
        !workable(before.status) &&
        this.#deps.runs.ofTask(id).length === 0
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
    this.#commit(taskId, "changed", () => {
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
    });
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
    } = {},
  ): { task: BoardTaskDetail; activity: TaskActivityView } {
    const { clientId } = options;
    const mentions = [...new Set(options.mentions ?? [])];
    const task = this.#existing(id);
    if (body.trim() === "") throw new Error("a comment needs some text");
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
      const data = {
        ...(clientId === undefined ? {} : { clientId }),
        ...(mentions.length === 0 ? {} : { mentions }),
      };
      activity = this.#deps.tasks.record(id, "comment", actor, {
        body,
        data: Object.keys(data).length === 0 ? undefined : data,
      })!;
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
    this.#deps.db.transaction(() => {
      for (const dependent of waiting)
        this.#commit(dependent, "changed", () => {
          this.#deps.tasks.record(
            dependent,
            "dependency",
            { kind: "system", agentId: null },
            { data: { action: "deleted", ...this.#refOf(task) } },
          );
        });
      this.#commit(id, "removed", () => {
        this.#deps.tasks.remove(id);
      });
    })();
    for (const other of awaited) this.#announce(other, "changed", []);
    this.#graphChanged();
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
    draft: Omit<DraftInput, "dependsOn"> & {
      dependsOn?: readonly DependencyInput[] | undefined;
    };
  }): MessageView {
    const dependsOn = this.#dependenciesOf(input.draft.dependsOn);
    const row = this.#deps.cards.draft({
      ...input,
      draft: {
        ...input.draft,
        base:
          input.draft.base === undefined
            ? undefined
            : this.#baseOf(input.draft.base),
        dependsOn: dependsOn.length === 0 ? undefined : dependsOn,
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
  }): { task: BoardTaskDetail; message: MessageView } {
    // The draft's dependencies were checked when it was drafted; much can change before it is
    // confirmed, so they are checked again here, in the same write that makes the task.
    const { task, message, created, dependsOn } = this.#deps.db.transaction(
      () => {
        const confirmed = this.#deps.cards.confirm({
          conversationId: input.conversationId,
          messageId: input.messageId,
          fields: this.#fieldsOf(input.edits ?? {}),
        });
        const edges = confirmed.created ? confirmed.dependsOn : [];
        const actor: TaskActor = { kind: "user", agentId: null };
        for (const edge of edges)
          this.#addEdge(
            confirmed.task.id,
            edge.taskId,
            edge.requireDone,
            actor,
          );
        return { ...confirmed, dependsOn: edges };
      },
    )();
    if (created) {
      this.#announce(task.id, "created", [input.conversationId]);
      for (const edge of dependsOn) this.#announce(edge.taskId, "changed", []);
      if (workable(task.status)) this.#runs?.start(task.id);
    }
    return { task: this.#detailOf(this.#existing(task.id)), message };
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

  /** A task's status moved: the tasks that wait for it read it again, and the graph settles. */
  #statusMoved(id: string): void {
    for (const edge of this.graph().dependentsOf(id))
      this.#announce(edge.taskId, "changed", []);
    this.#graphChanged();
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
        this.#commit(task.id, "changed", () => {
          this.#deps.tasks.record(task.id, "dependency", system, {
            data: { action: "unblocked" },
          });
          this.#deps.tasks.update(task.id, { status: "todo" }, system);
        });
        this.#runs?.start(task.id);
      }
    } finally {
      this.#settling = false;
    }
  }

  /** A change, the refresh of the task's cards in the same write, and then the news of it. */
  #commit(id: string, kind: BoardChange["kind"], work: () => void): void {
    let touched: string[] = [];
    this.#deps.db.transaction(() => {
      work();
      touched = this.#deps.cards.sync(id);
    })();
    this.#announce(id, kind, touched);
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
    };
  }

  /**
   * A task that came from a group is that group's work: only its members can be called into the
   * thread. One from a direct chat, or from nowhere, can call in any agent.
   */
  #checkMentions(task: TaskRecord, mentions: readonly string[]): void {
    if (mentions.length === 0 || task.originConversationId === null) return;
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
