import type {
  BoardTaskStatus,
  MessageView,
  TaskArtifactRef,
  TaskCardData,
  TaskDraftData,
  TaskDraftStatus,
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
 * card per conversation (only a confirmed draft or Captain's `dispatch_task` makes one, and a draft
 * is confirmed once). Making or linking a task in any other way puts no card in a timeline, and
 * deleting a task leaves its cards behind, marked, because what a reader still has is the card.
 */
import type { Database } from "bun:sqlite";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type { Timeline } from "../conversations/timeline";
import type { MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { TaskRecord, TaskStore } from "./store";
import { draftStatus } from "@eta/client-contracts";
import { checkExternalAgentProject } from "../agents/bounds";
import {
  assigneeScopeFor,
  CAPTAIN_ASSIGNEE_ERROR,
  resolveAssignee,
} from "./assignee";

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
   * Where the task lands when confirmed: `todo` (the default) starts it, `backlog` keeps it on the
   * board until the user moves it to todo.
   */
  status?: TaskDraftStatus | undefined;
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
  /** What the task will wait for, as the board found and checked it (`TaskDraftData.dependsOn`). */
  dependsOn?: { taskId: string; requireDone: boolean }[] | undefined;
  /** The task it will be a subtask of, as the board found and checked it. */
  parentId?: string | undefined;
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
  projects: ProjectStore;
  machines: MachineStore;
  /** Who an assignee is: a draft names it as the user did, the task keeps the registry's id. */
  agents: Pick<AgentStore, "get" | "list">;
  /** The newest version of each artifact published for a task, for the card to list. */
  artifactsOf: (taskId: string) => TaskArtifactRef[];
}

interface TaskCardExtra {
  turnMessageId?: string | undefined;
  captainAssignmentId?: string | undefined;
  captainRound?: number | undefined;
  captainNote?: string | undefined;
  taskNumber?: number | undefined;
}

/** What a card carries: the task's facts, plus the turn or Captain dispatch it came out of. */
export function taskCardData(
  task: TaskRecord,
  summary: string,
  artifacts: TaskArtifactRef[],
  extra: TaskCardExtra = {},
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
    ...(extra.turnMessageId === undefined
      ? {}
      : { turnMessageId: extra.turnMessageId }),
    ...(extra.captainAssignmentId === undefined
      ? {}
      : { captainAssignmentId: extra.captainAssignmentId }),
    ...(extra.captainRound === undefined
      ? {}
      : { captainRound: extra.captainRound }),
    ...(extra.captainNote === undefined
      ? {}
      : { captainNote: extra.captainNote }),
    ...(extra.taskNumber === undefined ? {} : { taskNumber: extra.taskNumber }),
  };
}

function preservedExtra(data: Record<string, unknown>): TaskCardExtra {
  return {
    turnMessageId:
      typeof data.turnMessageId === "string" ? data.turnMessageId : undefined,
    captainAssignmentId:
      typeof data.captainAssignmentId === "string"
        ? data.captainAssignmentId
        : undefined,
    captainRound:
      typeof data.captainRound === "number" ? data.captainRound : undefined,
    captainNote:
      typeof data.captainNote === "string" ? data.captainNote : undefined,
    taskNumber:
      typeof data.taskNumber === "number" ? data.taskNumber : undefined,
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
    // An assignee nobody is, or not in this group, or Captain, is refused now, while the proposer
    // can still name it again; the draft keeps the id, so the card and the task agree.
    const scope = assigneeScopeFor(input.conversationId, conversations);
    const assignee = resolveAssignee(
      input.draft.assignee,
      this.#deps.agents,
      scope,
    );
    if (
      assignee === undefined &&
      this.#deps.agents.get(input.agentId)?.systemRole === "captain"
    )
      throw new Error(CAPTAIN_ASSIGNEE_ERROR);
    const project = this.#deps.projects.get(conversation.projectId);
    const executor = this.#deps.agents.get(assignee ?? input.agentId);
    if (executor !== undefined && project !== undefined)
      checkExternalAgentProject(executor, project, this.#deps.machines);
    // The draft belongs to the turn that is writing it: that row says both where the draft came
    // from (the range of messages below) and where the page should draw it.
    const turn = this.#turnOf(input.conversationId, input.agentId);
    const source =
      input.draft.source?.trim() || this.#sourceOf(input.conversationId, turn);
    const data: TaskDraftData = {
      title,
      description: [
        `## Goal\n\n${input.draft.goal.trim()}`,
        `## Decided\n\n${(input.draft.decided ?? "").trim()}`,
        `## Acceptance criteria\n\n${input.draft.acceptance.trim()}`,
        `Source: conversation “${conversation.name}”, ${source}.`,
      ].join("\n\n"),
      workspace: input.draft.workspace,
      status: draftStatus(input.draft),
      ...(input.draft.base === undefined ? {} : { base: input.draft.base }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(input.draft.dependsOn === undefined
        ? {}
        : { dependsOn: input.draft.dependsOn }),
      ...(input.draft.parentId === undefined
        ? {}
        : { parentId: input.draft.parentId }),
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
    /** Set when the host confirms a draft nobody decided on; the task's first entry says so. */
    auto?: "timeout" | undefined;
  }): {
    task: TaskRecord;
    message: MessageView;
    created: boolean;
    /** What the draft said the task waits for; the board adds the edges. */
    dependsOn: { taskId: string; requireDone: boolean }[];
    /** The parent the draft named; the board sets it. */
    parentId?: string | undefined;
  } {
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
      return { task, message: row, created: false, dependsOn: [] };
    }

    const draft = row.data as unknown as TaskDraftData;
    if (draft.discarded) throw new Error("that draft was discarded");
    const title = (input.fields.title ?? draft.title).trim();
    if (title === "") throw new Error("a task needs a title");
    // Resolved again: a draft written before assignees were resolved may hold a name, the agent
    // it named may have been renamed, removed, or removed from the group since.
    const scope = assigneeScopeFor(
      input.conversationId,
      this.#deps.conversations,
    );
    const assignee = resolveAssignee(draft.assignee, this.#deps.agents, scope);
    if (assignee === undefined && row.agentId !== null) {
      const drafter = this.#deps.agents.get(row.agentId);
      if (drafter?.systemRole === "captain")
        throw new Error(CAPTAIN_ASSIGNEE_ERROR);
      if (scope?.memberIds !== undefined && !scope.memberIds.has(row.agentId))
        throw new Error(
          `agent "${drafter?.name ?? row.agentId}" (${row.agentId}) is no longer a member of group "${scope.conversationName ?? ""}"`,
        );
    }
    const conversation = this.#deps.conversations.get(input.conversationId);
    const project =
      conversation === undefined
        ? undefined
        : this.#deps.projects.get(conversation.projectId);
    const executor = this.#deps.agents.get(assignee ?? row.agentId ?? "");
    if (executor !== undefined && project !== undefined)
      checkExternalAgentProject(executor, project, this.#deps.machines);
    return db.transaction(() => {
      const task = tasks.create({
        title,
        description: input.fields.description ?? draft.description,
        // What the user chose on the way, else what the draft proposed; a draft from before drafts
        // said so is `todo`, as every draft was then.
        status: input.fields.status ?? draftStatus(draft),
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
        origin: {
          draftId: row.id,
          ...(input.auto === undefined ? {} : { auto: input.auto }),
        },
      });
      // The card keeps the draft's place in the conversation, including the turn it belongs to.
      const message = timeline.retype(row.id, "task_card", {
        ...taskCardData(task, "", this.#deps.artifactsOf(task.id), {
          turnMessageId: draft.turnMessageId,
        }),
      })!;
      this.#told(
        row,
        `created as task #${task.number}`,
        title,
        input.auto,
        task,
      );
      return {
        task,
        message,
        created: true,
        dependsOn: draft.dependsOn ?? [],
        parentId: draft.parentId,
      };
    })();
  }

  /**
   * Discard a draft: the row stays where it is, marked, and no task is made. Only a draft that
   * still waits is discarded; a confirmed or an already discarded one is refused, so confirming
   * and discarding exclude each other.
   */
  discard(input: {
    conversationId: string;
    messageId: string;
    /** Set when the host discards a draft nobody decided on, so the card does not say the user did. */
    auto?: "timeout" | undefined;
  }): MessageView {
    const { timeline } = this.#deps;
    const row = timeline.get(input.messageId);
    if (
      row === undefined ||
      row.conversationId !== input.conversationId ||
      (row.kind !== "task_draft" && row.kind !== "task_card")
    )
      throw new Error("no such task draft");
    if (row.kind === "task_card")
      throw new Error("that draft was already confirmed");
    if ((row.data as unknown as TaskDraftData).discarded)
      throw new Error("that draft was already discarded");
    const message = timeline.setData(row.id, {
      ...row.data,
      discarded: true,
      ...(input.auto === undefined ? {} : { autoHandled: input.auto }),
    })!;
    this.#told(
      row,
      "discarded, no task was made",
      String(row.data.title ?? ""),
      input.auto,
    );
    return message;
  }

  /** The drafts still waiting that were written at or before `cutoff`. */
  pendingBefore(cutoff: number): MessageView[] {
    return this.#deps.timeline.pendingDraftsBefore(cutoff);
  }

  /** Keep why the host could not confirm a draft on the draft; it stays pending. */
  failAuto(messageId: string, error: string): MessageView | undefined {
    const row = this.#deps.timeline.get(messageId);
    if (row === undefined || row.kind !== "task_draft") return undefined;
    return this.#deps.timeline.setData(row.id, {
      ...row.data,
      autoFailure: error,
    });
  }

  /**
   * Tell the agent that proposed a draft what became of it. A system row, like the steward's: it
   * wakes nobody, and the drafter reads it at its next wake with the rest of what it missed, so an
   * agent that is gone or idle is not called back by it. A draft has one outcome (confirming twice
   * makes no second row, a discarded one cannot be decided again), so it is told once. A draft
   * with no agent behind it has nobody to tell. `auto` says the host decided it on a timeout.
   */
  #told(
    row: MessageView,
    outcome: string,
    title: string,
    auto?: "timeout",
    task?: TaskRecord,
  ): void {
    if (row.agentId === null) return;
    const { agents, timeline } = this.#deps;
    const name = agents.get(row.agentId)?.name ?? "an agent that is gone";
    const who =
      auto === undefined
        ? "The user decided on"
        : "Nobody decided in time on, so the host settled,";
    timeline.system(
      row.conversationId,
      `${who} the task draft “${title}” by ${name}: ${outcome}.`,
      {
        event: "task_draft_decided",
        draftId: row.id,
        agentId: row.agentId,
        outcome: task === undefined ? "discarded" : "created",
        decidedBy: auto ?? "user",
        ...(task === undefined ? {} : { taskId: task.id, number: task.number }),
      },
    );
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
      const fresh =
        task === undefined
          ? undefined
          : taskCardData(
              task,
              tasks.lastComment(taskId),
              this.#deps.artifactsOf(taskId),
              preservedExtra(card.data),
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
    return first >= last ? `message ${last}` : `messages ${first}–${last}`;
  }
}
