/**
 * The task board's wire shapes (REFACTOR.md §9, P3.1).
 *
 * AXP's, because the web's task tab reads them: the board, a task's detail with its timeline, and
 * the list of who a task can be assigned to. The translator is where our rows and these fields
 * differ — our `created_by_agent` becomes `created_by`, our activity rows carry an actor object,
 * and the remote half (`run_status`, `assignee.computer_*`) is honestly empty until P4 fills it.
 */
import type { ActivityRecord, TaskDetail, TaskRecord } from "./store";

export interface AxpTaskActor {
  kind: "user" | "agent" | "remote" | "system";
  agent_id: string | null;
  agent_name: string | null;
}

export interface AxpTaskActivity {
  id: string;
  kind: string;
  actor: AxpTaskActor;
  run_id: string | null;
  body: string | null;
  data: Record<string, unknown>;
  created_at: string;
}

export interface AxpTaskAssignee {
  kind: "none" | "user" | "remote";
  computer_id: string | null;
  computer_name: string | null;
  runtime: string | null;
  provider: string | null;
}

export interface AxpTaskCreator {
  kind: "user" | "agent";
  agent_id: string | null;
  agent_name: string | null;
}

export interface AxpTask {
  group_id: string | null;
  id: string;
  number: number;
  title: string;
  status: string;
  assignee: AxpTaskAssignee;
  created_by: AxpTaskCreator;
  /** The assignee's latest run; remote work only, so null here until P4. */
  run_status: string | null;
  comments: number;
  created_at: string;
  updated_at: string;
}

export interface AxpTaskDetail extends AxpTask {
  description: string;
  activity: AxpTaskActivity[];
  runs: unknown[];
  assists: unknown[];
  loops: unknown[];
}

/** Who a task can be assigned to besides the user: the paired remote runtimes (P4). */
export interface AxpAssigneeOption {
  computer_id: string;
  computer_name: string;
  runtime: string;
  provider: string;
  online: boolean;
}

export interface AxpTaskList {
  tasks: AxpTask[];
  assignees: AxpAssigneeOption[];
}

export interface ShapeInput {
  agentName?: ((agentId: string) => string | undefined) | undefined;
  comments?: number | undefined;
}

const actorOf = (
  activity: ActivityRecord,
  agentName: ShapeInput["agentName"],
): AxpTaskActor => ({
  kind: activity.actor,
  agent_id: activity.actorAgent ?? null,
  agent_name:
    activity.actorAgent === undefined
      ? null
      : (agentName?.(activity.actorAgent) ?? null),
});

function toActivity(
  activity: ActivityRecord,
  options: ShapeInput = {},
): AxpTaskActivity {
  return {
    id: activity.id,
    kind: activity.kind,
    actor: actorOf(activity, options.agentName),
    run_id: null,
    body: activity.body ?? null,
    data: activity.data,
    created_at: activity.createdAt,
  };
}

export function toTask(task: TaskRecord, options: ShapeInput = {}): AxpTask {
  return {
    group_id: task.groupId ?? null,
    id: task.id,
    number: task.number,
    title: task.title,
    status: task.status,
    assignee: {
      kind: task.assignee,
      // The remote half of an assignee arrives with P4; a task here is for the user or nobody.
      computer_id: null,
      computer_name: null,
      runtime: null,
      provider: null,
    },
    created_by:
      task.createdByAgent === undefined
        ? { kind: "user", agent_id: null, agent_name: null }
        : {
            kind: "agent",
            agent_id: task.createdByAgent,
            agent_name: options.agentName?.(task.createdByAgent) ?? null,
          },
    run_status: null,
    comments: options.comments ?? 0,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

export function toTaskDetail(
  detail: TaskDetail,
  options: ShapeInput = {},
): AxpTaskDetail {
  return {
    ...toTask(detail, options),
    description: detail.description,
    activity: detail.activity.map((activity) => toActivity(activity, options)),
    // Remote runs, assistance requests and review loops: P4. Empty arrays rather than omitted
    // fields, so a client that reads `runs` sees "none" instead of a missing key.
    runs: [],
    assists: [],
    loops: [],
  };
}
