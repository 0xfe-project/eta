import type {
  BoardTaskAssignee,
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  MessageView,
  TaskActivityView,
  TaskActor,
  TaskArtifactRef,
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
import type { TaskRecord, TaskStore } from "./store";
import { TASK_ASSIGNEES, TASK_STATUSES } from "@eta/client-contracts";

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
  assignee?: string | undefined;
}

/** The same fields once they have been checked. */
interface Fields {
  title?: string;
  description?: string;
  status?: BoardTaskStatus;
  assignee?: BoardTaskAssignee;
}

export interface TaskBoardDeps {
  db: Database;
  tasks: TaskStore;
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
  assignee: task.assignee,
  createdBy: task.createdBy,
  conversationId: task.conversationId,
  comments: task.comments,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

export class TaskBoard {
  readonly #deps: TaskBoardDeps;
  readonly #listeners = new Set<(change: BoardChange) => void>();

  constructor(deps: TaskBoardDeps) {
    this.#deps = deps;
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

  create(
    input: FieldsInput & { title: string; conversationId?: string | undefined },
    actor: TaskActor,
  ): BoardTaskDetail {
    const { title, ...fields } = this.#fieldsOf(input);
    if (title === undefined) throw new Error("a task needs a title");
    const task = this.#deps.tasks.create({
      ...fields,
      title,
      conversationId: this.#conversation(input.conversationId),
      createdByAgent:
        actor.kind === "agent" ? (actor.agentId ?? undefined) : undefined,
    });
    // A task made this way has no card: only a confirmed draft puts one in a timeline.
    this.#announce(task.id, "created", []);
    return this.#detailOf(task);
  }

  update(id: string, input: FieldsInput, actor: TaskActor): BoardTaskDetail {
    this.#existing(id);
    const fields = this.#fieldsOf(input);
    this.#commit(id, "changed", () => {
      this.#deps.tasks.update(id, fields, actor);
    });
    return this.#detailOf(this.#existing(id));
  }

  comment(
    id: string,
    body: string,
    actor: TaskActor,
    clientId?: string,
  ): { task: BoardTaskDetail; activity: TaskActivityView } {
    this.#existing(id);
    if (body.trim() === "") throw new Error("a comment needs some text");
    // A retry with the same client id is the same comment: hand back the one already there.
    const earlier =
      clientId === undefined
        ? undefined
        : this.#deps.tasks.commentByClientId(id, clientId);
    if (earlier !== undefined)
      return { task: this.#detailOf(this.#existing(id)), activity: earlier };
    let activity!: TaskActivityView;
    this.#commit(id, "changed", () => {
      activity = this.#deps.tasks.record(id, "comment", actor, {
        body,
        data: clientId === undefined ? undefined : { clientId },
      })!;
    });
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

  /* ---------------------------------------------------------------- drafts */

  /** An agent proposes work in the conversation it is in; the user decides. */
  draft(input: {
    conversationId: string;
    agentId: string;
    draft: DraftInput;
  }): MessageView {
    const row = this.#deps.cards.draft(input);
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
    }
    return { task: this.#detailOf(task), message };
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
    return { ...task, artifacts: this.#deps.artifactsOf(task.id) };
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
    if (input.assignee !== undefined) {
      if (!(TASK_ASSIGNEES as readonly string[]).includes(input.assignee)) {
        throw new Error(
          `assignee must be one of ${TASK_ASSIGNEES.join(", ")}, not ${input.assignee}`,
        );
      }
      fields.assignee = input.assignee as BoardTaskAssignee;
    }
    return fields;
  }
}
