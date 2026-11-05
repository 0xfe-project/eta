import type { BoardTaskView, InteractionView } from "@eta/client-contracts";
import type { Inbox } from "../inbox/inbox";
import type { TaskBoard } from "../tasks/board";
import type { TaskRunner } from "../tasks/runner";
import type { TaskRunStore } from "../tasks/runs";
import type { CaptainAudit } from "./audit";
import type { CaptainService } from "./service";
import type { CaptainStore } from "./store";

export interface CaptainSupervisorDeps {
  store: CaptainStore;
  audit: CaptainAudit;
  captain: CaptainService;
  board: TaskBoard;
  runs: TaskRunStore;
  runner: TaskRunner;
  inbox: Inbox;
  now?: (() => number) | undefined;
  timer?: boolean | undefined;
  warn?: ((message: string) => void) | undefined;
  /** Redraw the Captain surface after an operation or alert was recorded. */
  changed?: (() => void) | undefined;
}

const MINUTE = 60_000;
const TICK = MINUTE;
const CHANGE_DEBOUNCE_MS = 150;
const ACTIVE = new Set(["todo", "in_progress"]);

/** Reserved signal from a future proactive source. No source is enabled in this release. */
interface CaptainWakeEvent {
  kind: string;
  data?: Record<string, unknown> | undefined;
}

export class CaptainSupervisor {
  readonly #deps: CaptainSupervisorDeps;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #requestTimer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #requested = false;
  #stopped = true;
  #lastPatrol = 0;
  readonly #eventListeners = new Set<(event: CaptainWakeEvent) => void>();

  constructor(deps: CaptainSupervisorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#stopped = false;
    this.tick();
    this.#lastPatrol = this.#now();
    this.#timer = setInterval(() => this.tick(), TICK);
    this.#timer.unref?.();
    if (this.#deps.timer === false) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    if (this.#requestTimer !== undefined) clearTimeout(this.#requestTimer);
    this.#timer = undefined;
    this.#requestTimer = undefined;
    this.#requested = false;
  }

  /** A domain change happened: coalesce work instead of scanning product state on every write. */
  requestTick(delayMs = CHANGE_DEBOUNCE_MS): void {
    if (this.#stopped) return;
    this.#requested = true;
    if (this.#requestTimer !== undefined) return;
    this.#requestTimer = setTimeout(() => {
      this.#requestTimer = undefined;
      if (!this.#requested) return;
      this.#requested = false;
      this.tick();
    }, delayMs);
    this.#requestTimer.unref?.();
  }

  /**
   * Reserve the proactive-wake seam without enabling a source yet. A future event producer can
   * deliver a signal here; consumers stay opt-in and ordinary scheduling remains unaffected.
   */
  onEvent(listener: (event: CaptainWakeEvent) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Deliver a reserved event to registered listeners; no built-in producer calls this yet. */
  wake(event: CaptainWakeEvent): void {
    for (const listener of [...this.#eventListeners]) listener(event);
  }

  /** Look at failures, inactivity, Inbox age and the patrol interval. Re-entrant calls coalesce. */
  tick = (): void => {
    if (this.#stopped) return;
    if (this.#requestTimer !== undefined) {
      clearTimeout(this.#requestTimer);
      this.#requestTimer = undefined;
    }
    this.#requested = false;
    if (this.#running) {
      this.#requested = true;
      return;
    }
    this.#running = true;
    try {
      const settings = this.#deps.store.settings();
      if (!settings.supervisorEnabled) return;
      const tasks = this.#deps.board.list();
      const inbox = this.#deps.inbox.list();
      this.#notifyPendingOperations();
      this.#handleFailures(tasks, settings.retryLimit);
      this.#handleStuck(tasks, settings.stuckMinutes);
      this.#handleInbox(inbox, settings.inboxMinutes);
      void this.#deps.captain
        .observeReviews({ tasks, inbox, settings })
        .catch((error: unknown) => {
          this.#deps.warn?.(
            `[eta] Captain review observer failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      const now = this.#now();
      if (now - this.#lastPatrol >= settings.patrolMinutes * MINUTE) {
        this.#lastPatrol = now;
        void this.#deps.audit.record({
          action: "captain.patrol",
          data: {
            tasks: tasks.length,
            pendingInbox: inbox.filter((item) => item.status === "pending")
              .length,
            pendingOperations: this.#deps.store
              .operations()
              .filter((operation) => operation.status === "pending").length,
          },
        });
      }
    } catch (error) {
      this.#deps.warn?.(
        `[eta] CaptainSupervisor: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.#running = false;
      this.#deps.changed?.();
      if (this.#requested) this.requestTick(0);
    }
  };

  #notifyPendingOperations(): void {
    for (const operation of this.#deps.store.operations()) {
      if (operation.status !== "pending") continue;
      this.#deps.store.addNotificationOnce({
        key: `operation:${operation.id}`,
        kind: "operation_pending",
        body: `Captain operation ${operation.kind} is waiting for approval.`,
        data: { operationId: operation.id, operationKind: operation.kind },
      });
    }
  }

  #handleFailures(tasks: readonly BoardTaskView[], limit: number): void {
    for (const task of tasks) {
      if (
        task.status === "backlog" ||
        task.status === "done" ||
        task.status === "cancelled"
      )
        continue;
      const runs = this.#deps.runs.ofTask(task.id);
      const latest = runs.at(-1);
      if (latest === undefined) continue;
      const retry = this.#deps.store.retryState(task.id);
      // A successful run breaks the failure streak. Queued/starting/running runs do not: they are
      // the retry of the failure we are counting, and clearing here would make the limit endless.
      if (latest.status === "completed") {
        if (retry.attempts !== 0 && retry.lastRunId !== latest.id)
          this.#deps.store.recordRetry(task.id, latest.id, 0, false);
        continue;
      }
      if (latest.status !== "failed") continue;
      const latestFailure = latest;
      if (retry.lastRunId === latestFailure.id) continue;
      const attempts = retry.attempts + 1;
      const nonRetryable = latestFailure.retryable === false;
      const stopped = nonRetryable || attempts >= limit;
      this.#deps.store.recordRetry(
        task.id,
        latestFailure.id,
        attempts,
        stopped,
      );
      void this.#deps.audit.record({
        action: "captain.task.failure",
        data: {
          taskId: task.id,
          runId: latestFailure.id,
          attempts,
          stopped,
          error: latestFailure.error,
        },
      });
      if (stopped) {
        this.#deps.store.createReview({
          kind: nonRetryable ? "task_failure_non_retryable" : "task_failure",
          dedupeKey: `task-failure:${task.id}:${latestFailure.id}`,
          taskId: task.id,
          body: `Task #${task.number} “${task.title}” failed ${attempts} time(s)${nonRetryable ? " with a non-retryable error" : ""}: ${latestFailure.error ?? "no error text"}.`,
          data: {
            taskId: task.id,
            taskNumber: task.number,
            runId: latestFailure.id,
            attempts,
            nonRetryable,
            errorCode: latestFailure.errorCode,
            error: latestFailure.error,
          },
        });
        this.#deps.store.addNotificationOnce({
          key: `retry-stop:${task.id}:${latestFailure.id}`,
          kind: "task_retry_stopped",
          body: nonRetryable
            ? `Task #${task.number} failed with a non-retryable error; automatic retries stopped.`
            : `Task #${task.number} failed ${attempts} times; automatic retries stopped.`,
          data: {
            taskId: task.id,
            runId: latestFailure.id,
            attempts,
            error: latestFailure.error,
            nonRetryable,
            errorCode: latestFailure.errorCode,
          },
        });
        continue;
      }
      try {
        this.#deps.runner.rerun(task.id);
      } catch (error) {
        this.#deps.warn?.(
          `[eta] Captain could not retry task ${task.number}: ${String(error)}`,
        );
      }
    }
  }

  #handleStuck(tasks: readonly BoardTaskView[], minutes: number): void {
    const now = this.#now();
    for (const task of tasks) {
      if (task.status === "blocked") {
        this.#deps.store.createReview({
          kind: "task_blocked",
          dedupeKey: `task-blocked:${task.id}:${task.updatedAt}`,
          taskId: task.id,
          body: `Task #${task.number} “${task.title}” is blocked.`,
          data: { taskId: task.id, updatedAt: task.updatedAt },
        });
        continue;
      }
      if (!ACTIVE.has(task.status)) continue;
      const open = this.#deps.runs.openOf(task.id);
      if (open.length > 0) {
        const lastEvent = open
          .map((run) => run.lastEventAt ?? run.startedAt ?? run.createdAt)
          .reduce((left, right) => Math.max(left, right), 0);
        if (now - lastEvent < minutes * MINUTE) continue;
        const ids = open.map((run) => run.id).sort();
        this.#deps.store.createReview({
          kind: "task_run_stuck",
          dedupeKey: `task-run-stuck:${task.id}:${ids.join(",")}:${lastEvent}`,
          taskId: task.id,
          body: `Task #${task.number} “${task.title}” has an open run with no progress for ${minutes} minutes.`,
          data: {
            taskId: task.id,
            runIds: ids,
            lastEventAt: lastEvent,
            updatedAt: task.updatedAt,
          },
        });
        continue;
      }
      if (now - task.updatedAt < minutes * MINUTE) continue;
      this.#deps.store.createReview({
        kind: "task_stalled",
        dedupeKey: `task-stalled:${task.id}:${task.updatedAt}`,
        taskId: task.id,
        body: `Task #${task.number} “${task.title}” stopped without an open run and has had no activity for ${minutes} minutes.`,
        data: { taskId: task.id, updatedAt: task.updatedAt },
      });
    }
  }

  #handleInbox(inbox: readonly InteractionView[], minutes: number): void {
    const now = this.#now();
    for (const item of inbox) {
      if (item.status !== "pending") continue;
      if (this.#deps.inbox.relayOf(item.id) !== null) {
        if (now - item.createdAt < minutes * MINUTE) continue;
        this.#deps.store.addNotificationOnce({
          key: `inbox-relay:${item.id}:${item.revision}`,
          kind: "inbox_relay_waiting",
          body: `Captain is waiting for the user's decision: ${item.prompt}`,
          data: {
            interactionId: item.id,
            sessionId: item.sessionId,
            conversationId: item.conversationId,
          },
        });
        continue;
      }
      // Captain-assigned questions are relayed immediately and tracked as their own review.
      if (this.#deps.captain.assignmentForInbox(item) !== undefined) continue;
      if (now - item.createdAt < minutes * MINUTE) continue;
      this.#deps.store.createReview({
        kind: "inbox_pending",
        dedupeKey: `inbox:${item.id}`,
        conversationId: item.conversationId,
        body: `An Inbox question has waited more than ${minutes} minutes: ${item.prompt}`,
        data: {
          interactionId: item.id,
          sessionId: item.sessionId,
          agentId: item.agentId,
          conversationId: item.conversationId,
        },
      });
      this.#deps.store.addNotificationOnce({
        key: `inbox:${item.id}`,
        kind: "inbox_pending",
        body: `An Inbox question has waited more than ${minutes} minutes: ${item.prompt}`,
        data: { interactionId: item.id, sessionId: item.sessionId },
      });
    }
  }
}
