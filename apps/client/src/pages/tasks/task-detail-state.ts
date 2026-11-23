import type {
  ArtifactView,
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal } from "nsh";
import { uiText } from "../../i18n";
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
  const posting = signal(false);
  const archive = signal(false);
  const editing = signal(false);
  const panel = signal(false);
  const plan = signal(false);
  const editTitle = signal("");
  const editDescription = signal("");
  /** The desktop page's title and description, each edited in place on its own. */
  const renaming = signal(false);
  const describing = signal(false);
  const log = signal<TaskRunView | undefined>(undefined);
  /** The artifact the timeline opened, at the version its entry names. */
  const artifact = signal<
    { artifact: ArtifactView; version?: number } | undefined
  >(undefined);
  const status = signal(false);
  /** The status a change is on its way to, until the host answers. */
  const changing = signal<BoardTaskStatus | undefined>(undefined);
  /** Why the last status change failed, under the status until the menu opens again. */
  const statusError = signal("");
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
  /**
   * Over a parent's comment box, as on the web: a task with subtasks does not run itself, so its
   * comment starts no run. Not while a run of its executor is going (one splitting the task), since
   * that run does read it. Every task takes comments, whatever its status (the host's rule).
   */
  const parentHint = (item: BoardTaskDetail) =>
    item.subtasks != null &&
    !item.runs.some(
      (run) => run.agentId === null && isActiveRunStatus(run.status),
    );
  const cancelledEdges = () =>
    (task()?.waitingOn ?? []).filter(
      (edge) => edge.state === "cancelled" && edge.via === null,
    );
  let feedbackId: string | undefined;
  const phone = () => props.layout === "phone";
  const side = () => props.layout === "desktop" && !props.docked;
  /** The last comment tried, with its id: a retry of the same words is the same comment. */
  let attempt: { body: string; id: string } | undefined;
  /** Posts a comment; whether the host took it (the box empties then). */
  async function post(text: string, mentions: string[] = []): Promise<boolean> {
    const body = text.trim();
    if (!body || posting()) return false;
    posting.set(true);
    if (attempt?.body !== body) attempt = { body, id: crypto.randomUUID() };
    const result = await host.action(() =>
      host.call("tasks", "comment", {
        taskId: props.id,
        body,
        clientId: attempt!.id,
        mentions: mentions.length ? mentions : undefined,
      }),
    );
    posting.set(false);
    if (result) attempt = undefined;
    return !!result;
  }
  async function mutate(work: () => Promise<void>) {
    if (submitting()) return;
    submitting.set(true);
    await host.action(work);
    submitting.set(false);
  }
  /** Saves the title being edited in place; an empty or unchanged one is dropped. */
  function saveTitle() {
    const title = editTitle().trim();
    if (!renaming()) return;
    renaming.set(false);
    if (!title || title === task()?.title) return;
    void mutate(async () => {
      await host.call("tasks", "update", { taskId: props.id, title });
    });
  }
  /** Saves `text` (the description editor's Markdown) as the task's description. */
  function saveDescription(text: string) {
    editDescription.set(text);
    void mutate(async () => {
      await host.call("tasks", "update", {
        taskId: props.id,
        description: text,
      });
      describing.set(false);
    });
  }
  function change(next: BoardTaskStatus) {
    if (submitting()) return;
    // The current status again changes nothing: no call, as on the web.
    if (next === task()?.status) {
      status.set(false);
      return;
    }
    statusError.set("");
    changing.set(next);
    void mutate(async () => {
      try {
        await host.call("tasks", "update", { taskId: props.id, status: next });
      } catch (problem) {
        statusError.set(
          uiText("statusChangeFailed", {
            message:
              problem instanceof Error ? problem.message : String(problem),
          }),
        );
        throw problem;
      } finally {
        changing.set(undefined);
      }
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
    id: props.id,
    activity,
    task,
    posting,
    archive,
    editing,
    panel,
    plan,
    editTitle,
    editDescription,
    renaming,
    describing,
    saveTitle,
    saveDescription,
    log,
    artifact,
    status,
    changing,
    statusError,
    review,
    feedback,
    submitting,
    replacing,
    cancelling,
    search,
    executor,
    activeArchiveTargets,
    parentHint,
    phone,
    side,
    post,
    mutate,
    change,
    submitReview,
    resolveBlock,
    stop,
    updateFeedback,
  };
}
