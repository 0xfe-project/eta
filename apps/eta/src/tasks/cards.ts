/**
 * Task cards in a group's timeline (REFACTOR.md §9, P3.1).
 *
 * The board and the conversation meet here. An agent (or the user) proposes work in a group and
 * the proposal is a *message* — kind `task_draft`, carrying a title and a description built from
 * what was agreed. Nothing is on the board yet, and nothing wakes an executor: a draft is an
 * invitation to decide. When the user confirms it, the same message row becomes the card
 * (`task_card`) and holds the task's facts from then on, refreshed whenever the task changes.
 *
 * One row, three states, and that is the point: the conversation keeps its history, the card is
 * where the proposal was, and there is no second copy of the task to drift.
 */
import type { TimelineProjector } from "../groups/projection";
import type { GroupStore, MessageRecord } from "../groups/store";
import type { TaskDetail, TaskRecord, TaskStore } from "./store";

export interface DraftInput {
  title: string;
  goal?: string | undefined;
  decided?: string | undefined;
  acceptance?: string | undefined;
  /** A plain-text range, e.g. "第 12–18 条"; the messages that led to this. */
  source?: string | undefined;
}

/** A confirm request: the draft's fields, as the user may have edited them. */
export interface ConfirmInput {
  title: string;
  description?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
}

export interface TaskCardsOptions {
  groups: GroupStore;
  tasks: TaskStore;
  projector: TimelineProjector;
  /**
   * The artifacts published for a task (P3.2), for the card to list.
   *
   * A callback rather than a store: the artifacts module already knows how to answer this, and this
   * one only needs the answer.
   */
  artifactsOf?:
    | ((
        taskId: string,
      ) => { artifact_id: string; title: string; version: number }[])
    | undefined;
}

/** What a card carries: the task's facts, in the product's field names. */
function cardData(
  task: TaskRecord | undefined,
  counts: { comments: number; summary: string; artifacts: unknown[] },
): Record<string, unknown> {
  if (task === undefined) return {};
  return {
    task_id: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    group_id: task.groupId ?? "",
    assignee: task.assignee,
    comments: counts.comments,
    summary: counts.summary,
    // Remote runs deliver pull requests (P4); artifacts are here already.
    deliverables: [],
    artifacts: counts.artifacts,
  };
}

export class TaskCards {
  readonly #groups: GroupStore;
  readonly #tasks: TaskStore;
  readonly #projector: TimelineProjector;
  readonly #artifactsOf:
    | ((
        taskId: string,
      ) => { artifact_id: string; title: string; version: number }[])
    | undefined;

  constructor(options: TaskCardsOptions) {
    this.#groups = options.groups;
    this.#tasks = options.tasks;
    this.#projector = options.projector;
    this.#artifactsOf = options.artifactsOf;
  }

  /**
   * Propose work in a group.
   *
   * The description is composed here rather than by the caller, because the shape is the
   * product's: goal, what was decided, how it will be judged, and where it came from. A caller
   * that wrote its own prose would produce a card nobody could compare with another.
   */
  draft(input: {
    groupId: string;
    agentId?: string | undefined;
    draft: DraftInput;
    rootMessageId?: string | undefined;
  }): MessageRecord | undefined {
    const group = this.#groups.get(input.groupId);
    if (group === undefined) return undefined;
    const title = input.draft.title.trim();
    if (title.length === 0) return undefined;
    const source = input.draft.source?.trim() ?? this.#sourceOf(input);
    const description = [
      `## 目标\n\n${input.draft.goal ?? ""}`,
      `## 已决定\n\n${input.draft.decided ?? ""}`,
      `## 验收标准\n\n${input.draft.acceptance ?? ""}`,
      `来源：群《${group.group.name}》${source}。`,
    ].join("\n\n");
    const message = this.#groups.append({
      groupId: input.groupId,
      kind: "task_draft",
      ...(input.agentId === undefined ? {} : { authorKind: "agent" as const }),
      ...(input.agentId === undefined ? {} : { authorAgentId: input.agentId }),
      ...(input.rootMessageId === undefined
        ? {}
        : { rootMessageId: input.rootMessageId }),
      data: { title, description },
    });
    if (message !== undefined) {
      this.#projector.notice({ groupId: input.groupId, message });
    }
    return message;
  }

  /**
   * Confirm a draft: the board gets a task, the message becomes its card.
   *
   * Confirming twice is one task — the draft carries the id once it has one, which is what makes
   * a double-click harmless. (AXP locked the conversation for this; an id on the row is the same
   * guarantee without the lock.)
   */
  confirm(input: {
    groupId: string;
    messageId: string;
    confirm: ConfirmInput;
    actorAgentId?: string | undefined;
  }): TaskDetail | undefined {
    const draft = this.#groups.message(input.messageId);
    if (draft === undefined || draft.groupId !== input.groupId)
      return undefined;
    if (draft.kind !== "task_draft" && draft.kind !== "task_card")
      return undefined;
    const existing = draft.data.task_id;
    if (typeof existing === "string" && existing.length > 0) {
      return this.#tasks.detail(existing);
    }
    const status = input.confirm.status;
    const assignee = input.confirm.assignee;
    const task = this.#tasks.create({
      title: input.confirm.title.trim(),
      ...(input.confirm.description === undefined
        ? {}
        : { description: input.confirm.description }),
      ...(status === undefined
        ? {}
        : { status: status as TaskRecord["status"] }),
      ...(assignee === "user" ? { assignee: "user" as const } : {}),
      ...(input.actorAgentId === undefined
        ? {}
        : { createdByAgent: input.actorAgentId }),
      groupId: input.groupId,
    });
    const card = this.#groups.append({
      groupId: input.groupId,
      kind: "task_card",
      replace: input.messageId,
      data: cardData(task, {
        comments: 0,
        summary: "",
        artifacts: [],
      }),
    });
    if (card !== undefined) {
      this.#projector.notice({ groupId: input.groupId, message: card });
    }
    return this.#tasks.detail(task.id);
  }

  /**
   * Refresh every card of a task with the task's facts.
   *
   * Called after a change rather than before a read: a card that is stale is a card that lies,
   * and the one place that knows a task changed is the call that changed it.
   */
  sync(taskId: string): MessageRecord[] {
    const task = this.#tasks.get(taskId);
    const counts = {
      comments: this.#tasks.comments(taskId),
      summary: this.#tasks.summary(taskId),
      artifacts: this.#artifactsOf?.(taskId) ?? [],
    };
    const updated: MessageRecord[] = [];
    for (const card of this.#cardsOf(taskId)) {
      const message = this.#groups.setData(
        card.id,
        task === undefined
          ? // The task is gone: the card stays as the record of what was proposed, and says
            // so rather than pointing at nothing.
            { ...card.data, deleted: true, task_id: taskId }
          : cardData(task, counts),
      );
      if (message !== undefined) {
        this.#projector.notice({ groupId: message.groupId, message });
        updated.push(message);
      }
    }
    return updated;
  }

  /** Every card in every group that points at this task. */
  #cardsOf(taskId: string): MessageRecord[] {
    const cards: MessageRecord[] = [];
    for (const { group } of this.#groups.list()) {
      for (const message of this.#groups.messages(group.id)) {
        if (message.kind !== "task_card") continue;
        if (message.data.task_id === taskId) cards.push(message);
      }
    }
    return cards;
  }

  /** The message range a draft came from, when the caller did not say. */
  #sourceOf(input: {
    groupId: string;
    rootMessageId?: string | undefined;
  }): string {
    const messages = this.#groups.messages(input.groupId);
    const last = messages.at(-1)?.seq ?? 0;
    const first =
      input.rootMessageId === undefined
        ? last
        : (messages.find((message) => message.id === input.rootMessageId)
            ?.seq ?? last);
    return first === last ? `第 ${first} 条` : `第 ${first}–${last} 条`;
  }
}
