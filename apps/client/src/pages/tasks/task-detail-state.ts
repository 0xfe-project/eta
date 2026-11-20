import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal } from "nsh";
import { follow, useHost } from "../../services/host";
import { isActiveRunStatus } from "./run-log";

export type TaskDetailState = ReturnType<typeof createTaskDetailState>;

export function createTaskDetailState(props: {
  id: string;
  layout: Layout;
  docked?: boolean;
}) {
  const host = useHost();
  const target = () => `tasks.${props.id}`;
  follow(target);
  const task = () => host.section<BoardTaskDetail>(target(), "task");
  const activity = () => host.list<TaskActivityView>(target(), "activity");
  const comment = signal("");
  const posting = signal(false);
  const archive = signal(false);
  const editing = signal(false);
  const panel = signal(false);
  const plan = signal(false);
  const editTitle = signal("");
  const editDescription = signal("");
  const log = signal<TaskRunView | undefined>(undefined);
  const status = signal(false);
  const review = signal<"done" | "todo" | undefined>(undefined);
  const feedback = signal("");
  const submitting = signal(false);
  const replacing = signal(false);
  const cancelling = signal(false);
  const search = signal("");
  const executor = () =>
    host.agent(task()?.assigneeAgentId ?? task()?.createdBy.agentId);
  const activeArchiveTargets = () => {
    const current = task();
    if (!current) return [];
    const byId = new Map(host.tasks().map((item) => [item.id, item]));
    return [...byId.values()].filter((item) => {
      if (!item.runStatus || !isActiveRunStatus(item.runStatus)) return false;
      let next: BoardTaskView | undefined = item;
      while (next) {
        if (next.id === current.id) return true;
        next = next.parentId ? byId.get(next.parentId) : undefined;
      }
      return false;
    });
  };
  const canComment = (item: BoardTaskDetail) =>
    !item.archivedAt &&
    !item.children?.length &&
    !item.waitingOn?.length &&
    ["todo", "in_progress", "blocked"].includes(item.status);
  const cancelledEdges = () =>
    (task()?.waitingOn ?? []).filter(
      (edge) => edge.state === "cancelled" && edge.via === null,
    );
  let feedbackId: string | undefined;
  const phone = () => props.layout === "phone";
  const side = () => props.layout === "desktop" && !props.docked;
  let commentId: string | undefined;
  async function post() {
    if (!comment().trim() || posting()) return;
    posting.set(true);
    commentId ??= crypto.randomUUID();
    const result = await host.action(() =>
      host.call("tasks", "comment", {
        taskId: props.id,
        body: comment().trim(),
        clientId: commentId,
      }),
    );
    posting.set(false);
    if (result) {
      comment.set("");
      commentId = undefined;
    }
  }
  async function mutate(work: () => Promise<void>) {
    if (submitting()) return;
    submitting.set(true);
    await host.action(work);
    submitting.set(false);
  }
  function change(next: BoardTaskStatus) {
    void mutate(async () => {
      await host.call("tasks", "update", { taskId: props.id, status: next });
      status.set(false);
      cancelling.set(false);
      review.set(undefined);
    });
  }
  function submitReview(next: "done" | "todo") {
    if (next === "done") {
      change("done");
      return;
    }
    const body = feedback().trim();
    if (!body) return;
    void mutate(async () => {
      feedbackId ??= crypto.randomUUID();
      await host.call("tasks", "comment", {
        taskId: props.id,
        body,
        clientId: feedbackId,
      });
      feedbackId = undefined;
      feedback.set("");
      review.set(undefined);
    });
  }
  function resolveBlock(replacement?: string) {
    void mutate(async () => {
      const edges = cancelledEdges();
      if (replacement)
        await host.call("tasks", "addDependency", {
          taskId: props.id,
          dependsOn: replacement,
        });
      for (const edge of edges)
        await host.call("tasks", "removeDependency", {
          taskId: props.id,
          dependsOn: edge.taskId,
        });
      replacing.set(false);
    });
  }
  function updateComment(value: string) {
    if (!posting() && value !== comment()) {
      commentId = undefined;
      comment.set(value);
    }
  }
  function updateFeedback(value: string) {
    if (!submitting() && value !== feedback()) {
      feedbackId = undefined;
      feedback.set(value);
    }
  }
  function stop(run: TaskRunView) {
    void mutate(async () => {
      await host.call("tasks", "interrupt", {
        taskId: props.id,
        runId: run.id,
      });
    });
  }
  return {
    activity,
    task,
    comment,
    posting,
    archive,
    editing,
    panel,
    plan,
    editTitle,
    editDescription,
    log,
    status,
    review,
    feedback,
    submitting,
    replacing,
    cancelling,
    search,
    executor,
    activeArchiveTargets,
    canComment,
    phone,
    side,
    post,
    mutate,
    change,
    submitReview,
    resolveBlock,
    stop,
    updateComment,
    updateFeedback,
  };
}
