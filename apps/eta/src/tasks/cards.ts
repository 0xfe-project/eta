import type {
  BoardTaskStatus,
  MessageView,
  TaskArtifactRef,
  TaskCardData,
  TaskDraftData,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * Task cards in a conversation's timeline.
 *
 * The board and a conversation meet here. An agent proposes work in a conversation, and the
 * proposal is a row of its timeline (`task_draft`) carrying a title and a description built from
 * what was agreed. Nothing is on the board yet and nothing is woken: a draft is an invitation to
 * decide. When the user confirms it, the same row becomes the task's card (`task_card`) and holds
 * the task's facts from then on, refreshed whenever the task changes. The agent that proposed it is
 * the task's executor, and the workspace it chose is where the executor will work.
 *
 * One row, three states, and that is the point: the conversation keeps its history, the card is
 * where the proposal was, and there is no second copy of the task to drift. A task has at most one
 * card per conversation (only a confirmed draft makes one, and a draft is confirmed once). Making
 * or linking a task in any other way puts no card in a timeline, and deleting a task leaves its
 * cards behind, marked, because what a reader still has is the card.
 */
import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { TaskRecord, TaskStore } from "./store";
import { resolveAssignee } from "./assignee";

/** What the agent says about the work it proposes. */
export interface DraftInput {
  title: string;
  goal: string;
  decided?: string | undefined;
  acceptance: string;
  /** Where in the conversation this came from, as plain text; the board works it out when absent. */
  source?: string | undefined;
  /** Where the executor works: a worktree of its own, or the project's directory. */
  workspace: TaskWorkspaceMode;
  /**
   * The branch (or `#number` of another task, resolved to its `eta/task-<number>` branch) the
   * worktree starts at; the board resolves it before making the task. Absent is the project
   * checkout's HEAD, the old behavior.
   */
  base?: string | undefined;
  /**
   * The agent the work is for, when it is not the one proposing: its name or id, which the draft
   * resolves to the registry's id (see `assignee.ts`). Absent is the proposing agent, which
   * executes it itself, as it always was.
   */
  assignee?: string | undefined;
  captainAssignmentId?: string | undefined;
  captainMessageId?: string | undefined;
}

/** What the user may have changed on the way to the board. */
export interface ConfirmFields {
  title?: string | undefined;
  description?: string | undefined;
  status?: BoardTaskStatus | undefined;
}

export interface TaskCardsDeps {
  db: Database;
  tasks: TaskStore;
  timeline: Timeline;
  conversations: ConversationStore;
  /** Who an assignee is: a draft names it as the user did, the task keeps the registry's id. */
  agents: Pick<AgentStore, "get" | "list">;
  /** The newest version of each artifact published for a task, for the card to list. */
  artifactsOf: (taskId: string) => TaskArtifactRef[];
}

/** What a card carries: the task's facts, and the turn the proposal came out of. */
function cardData(
  task: TaskRecord,
  summary: string,
  artifacts: TaskArtifactRef[],
  turnMessageId?: string | undefined,
): TaskCardData {
  return {
    taskId: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    runStatus: task.runStatus,
    conversationId: task.conversationId,
    comments: task.comments,
    summary,
    artifacts,
    ...(turnMessageId === undefined ? {} : { turnMessageId }),
  };
}

export class TaskCards {
  readonly #deps: TaskCardsDeps;

  constructor(deps: TaskCardsDeps) {
    this.#deps = deps;
  }

  /**
   * Propose work in a conversation.
   *
   * The description is composed here and not by the caller, because its shape is the product's:
   * goal, what was decided, how it will be judged, and where it came from. A caller that wrote its
   * own prose would make cards nobody could compare.
   */
  draft(input: {
    conversationId: string;
    agentId: string;
    draft: DraftInput;
  }): MessageView {
    const { conversations, timeline } = this.#deps;
    const conversation = conversations.get(input.conversationId);
    if (conversation === undefined)
      throw new Error(`no such conversation: ${input.conversationId}`);
    const title = input.draft.title.trim();
    if (title === "") throw new Error("a task needs a title");
    // An assignee nobody is, or more than one agent is, is refused now, while the proposer can
    // still name it again; the draft keeps the id, so the card and the task agree.
    const assignee = resolveAssignee(input.draft.assignee, this.#deps.agents);
    // The draft belongs to the turn that is writing it: that row says both where the draft came
    // from (the range of messages below) and where the page should draw it.
    const turn = this.#turnOf(input.conversationId, input.agentId);
    const source =
      input.draft.source?.trim() || this.#sourceOf(input.conversationId, turn);
    const data: TaskDraftData = {
      title,
      description: [
        `## 目标\n\n${input.draft.goal.trim()}`,
        `## 已决定\n\n${(input.draft.decided ?? "").trim()}`,
        `## 验收标准\n\n${input.draft.acceptance.trim()}`,
        `来源：对话《${conversation.name}》${source}。`,
      ].join("\n\n"),
      workspace: input.draft.workspace,
      ...(input.draft.base === undefined ? {} : { base: input.draft.base }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(input.draft.captainAssignmentId === undefined
        ? {}
        : { captainAssignmentId: input.draft.captainAssignmentId }),
      ...(input.draft.captainMessageId === undefined
        ? {}
        : { captainMessageId: input.draft.captainMessageId }),
      ...(turn === undefined ? {} : { turnMessageId: turn.id }),
    };
    return timeline.append({
      conversationId: input.conversationId,
      kind: "task_draft",
      author: "agent",
      agentId: input.agentId,
      data: { ...data },
    });
  }

  /**
   * Confirm a draft: the board gets a task and the draft's row becomes its card.
   *
   * Confirming twice is one task. The row says so itself: once it is a card it names its task, and
   * a second confirm of it finds that task instead of making another, which is what makes a double
   * click or a retry harmless. All of it is one write, so a draft is never half confirmed.
   */
  confirm(input: {
    conversationId: string;
    messageId: string;
    fields: ConfirmFields;
  }): { task: TaskRecord; message: MessageView; created: boolean } {
    const { db, tasks, timeline } = this.#deps;
    const row = timeline.get(input.messageId);
    if (
      row === undefined ||
      row.conversationId !== input.conversationId ||
      (row.kind !== "task_draft" && row.kind !== "task_card")
    )
      throw new Error("no such task draft");
    if (row.kind === "task_card") {
      const task = tasks.get(String(row.data.taskId));
      if (task === undefined) throw new Error("that task was deleted");
      return { task, message: row, created: false };
    }

    const draft = row.data as unknown as TaskDraftData;
    const title = (input.fields.title ?? draft.title).trim();
    if (title === "") throw new Error("a task needs a title");
    // Resolved again: a draft written before assignees were resolved may hold a name, and the
    // agent it named may have been renamed or removed since.
    const assignee = resolveAssignee(draft.assignee, this.#deps.agents);
    return db.transaction(() => {
      const task = tasks.create({
        title,
        description: input.fields.description ?? draft.description,
        status: input.fields.status,
        // The agent that proposed it executes it, unless the draft says it is for someone else.
        createdByAgent: row.agentId ?? undefined,
        assigneeAgent: assignee,
        captainAssignmentId: draft.captainAssignmentId,
        captainMessageId: draft.captainMessageId,
        baseBranch: draft.base || undefined,
        projectId: this.#deps.conversations.get(input.conversationId)
          ?.projectId,
        workspaceMode: draft.workspace ?? "local",
        conversationId: input.conversationId,
        origin: { draftId: row.id },
      });
      // The card keeps the draft's place in the conversation, including the turn it belongs to.
      const message = timeline.retype(row.id, "task_card", {
        ...cardData(
          task,
          "",
          this.#deps.artifactsOf(task.id),
          draft.turnMessageId,
        ),
      })!;
      return { task, message, created: true };
    })();
  }

  /**
   * Make every card of a task say what the task says now, and return the conversations whose
   * timeline moved. Called by whatever changed the task, in the same write: a card that is stale
   * is a card that lies, and the call that changed the task is the one place that knows. A card
   * that already says it is left alone, so a change that changed nothing moves nothing.
   */
  sync(taskId: string): string[] {
    const { tasks, timeline } = this.#deps;
    const cards = timeline.cardsOf(taskId);
    if (cards.length === 0) return [];
    const task = tasks.get(taskId);
    const touched = new Set<string>();
    for (const card of cards) {
      const turnMessageId = card.data.turnMessageId as string | undefined;
      const fresh =
        task === undefined
          ? undefined
          : cardData(
              task,
              tasks.lastComment(taskId),
              this.#deps.artifactsOf(taskId),
              turnMessageId,
            );
      // A deleted task: the card stays as the record of what was proposed, and says so rather
      // than pointing at nothing.
      const next =
        fresh === undefined ? { ...card.data, deleted: true } : { ...fresh };
      if (JSON.stringify(next) === JSON.stringify(card.data)) continue;
      timeline.setData(card.id, next);
      touched.add(card.conversationId);
    }
    return [...touched];
  }

  /** The reply this agent is writing right now, when it is writing one. */
  #turnOf(conversationId: string, agentId: string): MessageView | undefined {
    return this.#deps.timeline
      .active(conversationId)
      .find((row) => row.agentId === agentId);
  }

  /** The range of the conversation a draft by this agent covers, when it did not say. */
  #sourceOf(conversationId: string, turn: MessageView | undefined): string {
    const { conversations, timeline } = this.#deps;
    const last = conversations.get(conversationId)?.lastSeq ?? 0;
    // The row that woke the agent is where the discussion it is summing up begins.
    const trigger =
      turn?.replyToId == null ? undefined : timeline.get(turn.replyToId);
    const first = trigger?.seq ?? last;
    return first >= last ? `第 ${last} 条` : `第 ${first}–${last} 条`;
  }
}
