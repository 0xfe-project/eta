/**
 * What waits on the user and what the panel and `/tasks` list, computed from the wire's state
 * alone: nothing here keeps a copy, so an item answered or moved elsewhere goes as the host says.
 */
import type {
  AgentView,
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  ConversationSummary,
  InteractionView,
  TaskActivityView,
} from "@eta/client-contracts";
import type { WireState } from "../../connection/types";
import { withoutCaptainConversation } from "../kit/captain";

type Targets = Pick<WireState, "targets">;

/** A question or a task, as the lists have it. */
export type ItemFacts =
  | { kind: "question"; interaction: InteractionView }
  | { kind: "task"; task: BoardTaskView };

/** One thing waiting on the user: a pending question, or a task blocked or in review. */
export type PendingItem = ItemFacts & { key: string; at: number };

/** Which item, independent of its current facts. */
export type ItemRef = Pick<PendingItem, "kind"> & { id: string };

/** The start of an id, for a name the lists do not have. */
const ID_PREFIX = 8;

const WAITING_TASK: ReadonlySet<BoardTaskStatus> = new Set([
  "blocked",
  "in_review",
]);
const CLOSED_TASK: ReadonlySet<BoardTaskStatus> = new Set([
  "done",
  "cancelled",
]);

function listOf<T>(state: Targets, target: string): readonly T[] {
  return (state.targets[target]?.sections.list as T[] | undefined) ?? [];
}

export const inboxList = (state: Targets) =>
  listOf<InteractionView>(state, "inbox");
export const taskList = (state: Targets) =>
  listOf<BoardTaskView>(state, "tasks");
export const agentList = (state: Targets) => listOf<AgentView>(state, "agents");
const NO_CONVERSATIONS: readonly ConversationSummary[] = [];

/** The conversations, without Captain's own one. */
export const conversationSummaries = (state: Targets) =>
  withoutCaptainConversation(
    (state.targets.conversations?.sections.list as
      | ConversationSummary[]
      | undefined) ?? NO_CONVERSATIONS,
    state.targets.agents?.sections.list as AgentView[] | undefined,
  );

export const questionKey = (id: string) => `question:${id}`;
export const taskKey = (id: string) => `task:${id}`;
export const keyOf = (ref: ItemRef) =>
  ref.kind === "question" ? questionKey(ref.id) : taskKey(ref.id);

export const isWaitingTask = (task: BoardTaskView) =>
  WAITING_TASK.has(task.status);

export const isPendingQuestion = (interaction: InteractionView) =>
  interaction.status === "pending";

/** Everything waiting, oldest first: a question by when it was asked, a task by its last change. */
export function pendingItems(state: Targets): PendingItem[] {
  const questions: PendingItem[] = inboxList(state)
    .filter(isPendingQuestion)
    .map((interaction) => ({
      kind: "question",
      key: questionKey(interaction.id),
      at: interaction.createdAt,
      interaction,
    }));
  const tasks: PendingItem[] = taskList(state)
    .filter(isWaitingTask)
    .map((task) => ({
      kind: "task",
      key: taskKey(task.id),
      at: task.updatedAt,
      task,
    }));
  return [...questions, ...tasks].sort((a, b) => a.at - b.at);
}

/** How many items wait: as many as `pendingItems` lists. */
export function pendingCount(state: Targets): number {
  return (
    inboxList(state).filter(isPendingQuestion).length +
    taskList(state).filter(isWaitingTask).length
  );
}

/** The conversations not archived, the one with the newest message first. */
export function panelConversations(state: Targets): ConversationSummary[] {
  const activity = (c: ConversationSummary) => c.lastMessageAt ?? c.updatedAt;
  return conversationSummaries(state)
    .filter((c) => !c.archived)
    .sort((a, b) => activity(b) - activity(a));
}

/**
 * The tasks not done or cancelled: the waiting ones first, oldest first, then the rest, newest
 * first; and how many are done or cancelled.
 */
export function openTasks(state: Targets): {
  open: BoardTaskView[];
  closed: number;
} {
  const all = taskList(state);
  const waiting = all
    .filter(isWaitingTask)
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const rest = all
    .filter((task) => !isWaitingTask(task) && !CLOSED_TASK.has(task.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    open: [...waiting, ...rest],
    closed: all.filter((task) => CLOSED_TASK.has(task.status)).length,
  };
}

/**
 * The conversation an item belongs to: a question's own; a task's linked one, else the one it was
 * proposed in (known once its details came).
 */
export function itemConversationId(
  item: ItemFacts,
  detail?: Pick<BoardTaskDetail, "originConversationId">,
): string | undefined {
  if (item.kind === "question")
    return item.interaction.conversationId ?? undefined;
  return item.task.conversationId ?? detail?.originConversationId ?? undefined;
}

/** An agent's name, or undefined when the list does not have it. */
export function agentName(
  state: Targets,
  agentId: string | null,
): string | undefined {
  if (agentId === null) return undefined;
  return agentList(state).find((agent) => agent.id === agentId)?.name;
}

/** A conversation's name from the list, else the start of its id. */
export function conversationName(state: Targets, id: string): string {
  return (
    conversationSummaries(state).find((c) => c.id === id)?.name ??
    id.slice(0, ID_PREFIX)
  );
}

/**
 * Who asks and where: `<agent> · <conversation>`, the agent alone outside a conversation, and the
 * start of the session id when the agent is unknown too.
 */
export function questionTitle(
  state: Targets,
  interaction: InteractionView,
): string {
  const who =
    agentName(state, interaction.agentId) ??
    interaction.sessionId.slice(0, ID_PREFIX);
  return interaction.conversationId === null
    ? who
    : `${who} · ${conversationName(state, interaction.conversationId)}`;
}

/** The first line of a text. */
export const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? "";

/** A task's details and activity, once its own target came. */
export function taskDetail(
  state: Targets,
  taskId: string,
):
  | { task: BoardTaskDetail; activity: readonly TaskActivityView[] }
  | undefined {
  const sections = state.targets[`tasks.${taskId}`]?.sections;
  const task = sections?.task as BoardTaskDetail | undefined;
  if (task === undefined) return undefined;
  return {
    task,
    activity: (sections?.activity as TaskActivityView[] | undefined) ?? [],
  };
}

/** The newest comment in a task's activity. */
export function lastComment(
  activity: readonly TaskActivityView[],
): TaskActivityView | undefined {
  return activity.filter((entry) => entry.kind === "comment").at(-1);
}
