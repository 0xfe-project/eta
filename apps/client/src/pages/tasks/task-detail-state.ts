import type {
  ArtifactView,
  AttachmentView,
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, signal } from "nsh";
import { createOptimisticStatus } from "../../components/optimistic-status";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { problemText } from "../../services/problem-text";
import { isActiveRunStatus } from "./run-log";

export type TaskDetailState = ReturnType<typeof createTaskDetailState>;

export function createTaskDetailState(props: {
  id: string;
  layout: Layout;
  docked?: boolean;
}) {
  const host = useHost();
  const retryTick = signal(0);
  const target = () => `tasks.${props.id}`;
  follow(() => {
    retryTick();
    return target();
  });
  const task = () => host.section<BoardTaskDetail>(target(), "task");
  const missing = () => Boolean(host.state().missing[target()]);
  const retryTask = () => {
    retryTick.update((count) => count + 1);
    host.reconnect();
  };
  const load = useLoadState({
    targets: () => [target()],
    ready: () => task() !== undefined,
  });
  const listed = () =>
    host.tasks().some((item) => item.id === props.id) ||
    host
      .list<{ id: string }>("tasks", "archived")
      .some((item) => item.id === props.id);
  // Seen on the board once: one just made, not listed yet, is not taken for deleted.
  const seen = signal(false);
  effect(() => {
    if (listed()) seen.set(true);
  });
  /** Deleted, here or elsewhere (the board had it and has it no more), or not on this host. */
  const gone = () =>
    (seen() && !!host.state().targets.tasks && !listed()) ||
    load.failure() === "missing";
  const pendingComments = signal<TaskActivityView[]>([]);
  const activity = () => {
    const hostItems = host.list<TaskActivityView>(target(), "activity");
    const pending = pendingComments();
    if (!pending.length) return hostItems;
    return [...hostItems, ...pending];
  };
  const posting = signal(false);
  const commentStatus = createOptimisticStatus();
  const editStatus = createOptimisticStatus();
  let lastEditAction: (() => void) | undefined;
  let lastStatusTarget: BoardTaskStatus | undefined;
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
  let attempt: { key: string; id: string } | undefined;
  /** Posts a comment optimistically (reusing idempotent `clientId` on retry); preserves input on failure. */
  async function post(
    text: string,
    mentions: string[] = [],
    attachments: readonly AttachmentView[] = [],
  ): Promise<boolean> {
    const body = text.trim();
    if ((!body && !attachments.length) || posting()) return false;
    posting.set(true);
    commentStatus.saving();
    // The same words with the same files: a retry of the same comment.
    const key = JSON.stringify([body, attachments.map((file) => file.id)]);
    if (attempt?.key !== key) attempt = { key, id: crypto.randomUUID() };
    const clientId = attempt.id;
    const optimisticRow: TaskActivityView = {
      id: `optimistic-${clientId}`,
      kind: "comment",
      actor: { kind: "user", agentId: null },
      body,
      runId: null,
      data: attachments.length ? { attachments } : {},
      createdAt: Date.now(),
    };
    pendingComments.update((all) => [
      ...all.filter((entry) => entry.id !== optimisticRow.id),
      optimisticRow,
    ]);
    try {
      await host.call("tasks", "comment", {
        taskId: props.id,
        body,
        clientId,
        mentions: mentions.length ? mentions : undefined,
        attachments: attachments.length
          ? attachments.map((file) => file.id)
          : undefined,
      });
      attempt = undefined;
      commentStatus.saved();
      return true;
    } catch (problem) {
      commentStatus.fail(
        problem instanceof Error ? problem.message : String(problem),
      );
      return false;
    } finally {
      pendingComments.update((all) =>
        all.filter((entry) => entry.id !== optimisticRow.id),
      );
      posting.set(false);
    }
  }
  async function mutate(work: () => Promise<void>) {
    if (submitting()) return;
    submitting.set(true);
    await host.action(work);
    submitting.set(false);
  }
  function applyTitle(title: string) {
    lastEditAction = () => applyTitle(title);
    editStatus.saving();
    void host
      .optimistic(props.id, { title }, () =>
        host.call("tasks", "update", { taskId: props.id, title }),
      )
      .then(() => {
        editStatus.saved();
      })
      .catch((problem: unknown) => {
        editTitle.set(title);
        editStatus.fail(
          problem instanceof Error ? problem.message : String(problem),
        );
      });
  }
  /** Saves the title being edited in place optimistically; an empty or unchanged one is dropped. */
  function saveTitle() {
    const title = editTitle().trim();
    if (!renaming()) return;
    renaming.set(false);
    if (!title || title === task()?.title) return;
    applyTitle(title);
  }
  function applyDescription(text: string) {
    lastEditAction = () => applyDescription(text);
    editStatus.saving();
    void host
      .optimistic(props.id, { description: text }, () =>
        host.call("tasks", "update", {
          taskId: props.id,
          description: text,
        }),
      )
      .then(() => {
        editStatus.saved();
      })
      .catch((problem: unknown) => {
        editDescription.set(text);
        editStatus.fail(
          problem instanceof Error ? problem.message : String(problem),
        );
      });
  }
  /** Saves `text` (the description editor's Markdown) optimistically; rolls back and preserves text on error. */
  function saveDescription(text: string) {
    editDescription.set(text);
    describing.set(false);
    applyDescription(text);
  }
  function retryEdit() {
    lastEditAction?.();
  }
  function retryStatus() {
    if (lastStatusTarget) change(lastStatusTarget);
  }
  /**
   * Changes the status ahead of the host (#380): every place that shows the task shows the new
   * status at once, and the menu, the sheet or the dialog that asked closes. If the host refuses
   * it, the old status comes back and why is said under the status, where it was changed (not in
   * the app's error strip too).
   */
  function change(next: BoardTaskStatus) {
    if (submitting()) return;
    // The current status again changes nothing: no call, as on the web.
    if (next === task()?.status) {
      status.set(false);
      return;
    }
    lastStatusTarget = next;
    statusError.set("");
    changing.set(next);
    status.set(false);
    cancelling.set(false);
    review.set(undefined);
    void host
      .optimistic(props.id, { status: next }, () =>
        host.call("tasks", "update", { taskId: props.id, status: next }),
      )
      .catch((problem: unknown) => {
        statusError.set(
          uiText("statusChangeFailed", {
            message: problemText(problem),
          }),
        );
      })
      .finally(() => {
        if (changing() === next) changing.set(undefined);
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
    missing,
    retryTask,
    load,
    gone,
    posting,
    commentStatus,
    editStatus,
    retryEdit,
    retryStatus,
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
