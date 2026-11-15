import type { Task } from "@/queries/tasks";
import { agentName, useAgentList } from "@/queries/agents";
import { useConversationList } from "@/queries/conversations";
import { executorOf } from "./task-plan";

// Two small readings of a task the task pages share: its project, and its executor's name.

/** A task's project, as the page can tell it: its conversation's. */
export function useProjectOf() {
  const { conversations } = useConversationList();
  const byId = new Map(conversations.map((c) => [c.id, c.projectId]));
  return (task: Pick<Task, "conversationId">) =>
    task.conversationId === null ? undefined : byId.get(task.conversationId);
}

/** Who executes a task, by name; "me" for a task with no agent. */
export function useExecutorName(task: Task) {
  const { agents } = useAgentList();
  const id = executorOf(task);
  return id === null ? undefined : agentName(agents, id);
}
