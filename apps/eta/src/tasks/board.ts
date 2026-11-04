import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  MessageView,
  TaskActivityKind,
  TaskActivityView,
  TaskActor,
  TaskArtifactRef,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * The task board: what can be done to tasks, whoever asks.
 *
 * The wire actions and the agents' tools are two ways in to the same handful of operations, and
 * what an operation owes does not depend on the way in: the fields are checked, the change and
 * the activity it leaves are one write, every card of the task is refreshed in that same write,
 * and then the people looking are told, the conversations whose cards moved and the board itself.
 * That is all this class is; the rows are `store.ts` and the cards `cards.ts`.
 */
import type { Database } from "bun:sqlite";
import type { ConversationStore } from "../conversations/store";
import type { DraftInput, TaskCards } from "./cards";
import type { TaskRunStore } from "./runs";
import type { TaskRecord, TaskStore } from "./store";
import { TASK_STATUSES } from "@eta/client-contracts";

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
  /** The newest version of each artifact published for a task. */
  artifactsOf: (taskId: string) => TaskArtifactRef[];
  /** These conversations' timelines moved. */
  changed: (conversationIds: readonly string[]) => void;
}

/** A task as the board lists it: without what only its own page shows. */
const viewOf = (task: TaskRecord): BoardTaskView => ({
  id: task.id,
  number: task.number,
  title: task.title,
  status: task.status,
  createdBy: task.createdBy,
  assigneeAgentId: task.assigneeAgentId,
  conversationId: task.conversationId,
  runStatus: task.runStatus,
  comments: task.comments,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

export class TaskBoard {
  readonly #deps: TaskBoardDeps;
  readonly #listeners = new Set<(change: BoardChange) => void>();
  #runs: TaskRuns | undefined;

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
    return this.#deps.tasks.list().map(viewOf);
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
      /** The agent the work is for, when that is not the maker. */
      assignee?: string | undefined;
    },
    actor: TaskActor,
  ): BoardTaskDetail {
    if (actor.kind !== "agent" || actor.agentId === null)
      throw new Error("only an agent makes a task");
    const { title, ...fields } = this.#fieldsOf(input);
    const { base, assignee } = input;
    if (title === undefined) throw new Error("a task needs a title");
    const conversationId = this.#conversation(input.conversationId)!;
    const task = this.#deps.tasks.create({
      ...fields,
      title,
      conversationId,
      createdByAgent: actor.agentId,
      assigneeAgent: assignee || undefined,
      baseBranch: base === undefined ? undefined : this.#baseOf(base),
      projectId: this.#deps.conversations.get(conversationId)?.projectId,
      workspaceMode: input.workspace,
    });
    this.#announce(task.id, "created", []);
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
    }
    return this.#detailOf(after);
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

  /** Delete a task. Its cards stay in the timelines they are in, and say it is gone. */
  remove(id: string): void {
    this.#existing(id);
    if (this.#runs?.active(id) === true)
      throw new Error("a run is working on this task; stop it before deleting");
    this.#commit(id, "removed", () => {
      this.#deps.tasks.remove(id);
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

  /** An agent proposes work in the conversation it is in; the user decides. */
  draft(input: {
    conversationId: string;
    agentId: string;
    draft: DraftInput;
  }): MessageView {
    const row = this.#deps.cards.draft({
      ...input,
      draft: {
        ...input.draft,
        base:
          input.draft.base === undefined
            ? undefined
            : this.#baseOf(input.draft.base),
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
    const { task, message, created } = this.#deps.cards.confirm({
      conversationId: input.conversationId,
      messageId: input.messageId,
      fields: this.#fieldsOf(input.edits ?? {}),
    });
    if (created) {
      this.#announce(task.id, "created", [input.conversationId]);
      if (workable(task.status)) this.#runs?.start(task.id);
    }
    return { task: this.#detailOf(this.#existing(task.id)), message };
  }

  /* ---------------------------------------------------------------- inside */

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
    return {
      ...viewOf(task),
      description,
      projectId,
      originConversationId,
      workspace: {
        mode: workspaceMode,
        base: baseBranch,
        path: worktreePath,
        branch: worktreeBranch,
      },
      artifacts: this.#deps.artifactsOf(task.id),
      runs: this.#deps.runs.ofTask(task.id).map(({ taskId: _, ...run }) => run),
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
