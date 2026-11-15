import type { Progress } from "./task-plan";
import type { Task } from "@/queries/tasks";
import { translate } from "@/lib/i18n";
import { statusLabel } from "./task-format";
import {
  blockedReason,
  isWaiting,
  releaseOf,
  waitsOf,
  waitSummary,
} from "./task-plan";

// The sentences the board, the list and the plan say a task with.

/** A stripe pattern on the card's own background: the task waits, it is not a status. */
export const waitingStripes =
  "bg-[repeating-linear-gradient(-45deg,var(--color-card)_0_7px,var(--color-muted)_7px_8px)]";

const countKey = {
  done: "done",
  in_review: "inReview",
  in_progress: "inProgress",
  blocked: "blocked",
  waiting: "waiting",
  todo: "todo",
  backlog: "backlog",
} as const;

/** "2 done · 1 in review · 1 running · 1 waiting". */
export function progressCounts(progress: Progress) {
  return progress.counts
    .map(({ segment, count }) =>
      translate(`tasks:cards.counts.${countKey[segment]}`, { count }),
    )
    .join(" · ");
}

/** "Unlocks 2 tasks" before it is delivered, "Let 1 go" after; nothing when nobody waits for it. */
export function releaseLabel(
  task: Task,
  all: readonly Task[],
): string | undefined {
  const { waiting, released } = releaseOf(task, all);
  // Done is settled: the card says when instead.
  if (task.status === "done" || task.status === "cancelled") return undefined;
  if (released > 0 && task.status === "in_review")
    return translate("tasks:cards.released", { count: released });
  if (waiting > 0) return translate("tasks:cards.unlocks", { count: waiting });
  if (released > 0)
    return translate("tasks:cards.released", { count: released });
  return undefined;
}

/** Why a blocked task is stuck, in a sentence. */
export function blockedLine(task: Task, all: readonly Task[]): string {
  const reason = blockedReason(task, all);
  switch (reason.kind) {
    case "cancelled":
      return translate("tasks:cards.blockedCancelled", { title: reason.title });
    case "cancelledMany":
      return translate("tasks:cards.blockedCancelledMany", {
        count: reason.count,
      });
    case "allCancelled":
      return translate("tasks:cards.blockedAllCancelled");
    default:
      return translate("tasks:cards.blockedDecide");
  }
}

// --- a task's own page --------------------------------------------------------------

/** What the page knows of the machine a queued run waits on. */
export interface QueueMachine {
  reason: "machine_full" | "machine_offline" | "task_busy" | "waiting_deps";
  name: string | undefined;
  /** How many runs it holds at once: all taken, when it is full. */
  max: number | undefined;
}

/**
 * Why the task has not started, as one sentence: whom it waits for and what happens when they are
 * there (who starts it, and from which branch), or that a machine has no room. Undefined when it
 * is not waiting.
 */
export function queueSentence(
  task: Task & { workspace?: { base: string | null } },
  all: readonly Task[],
  who: string,
  machine?: QueueMachine,
): string | undefined {
  if (isWaiting(task)) {
    const waiting = waitsOf(task).filter((w) => w.state === "waiting");
    if (waiting.length === 1) {
      const wait = waitSummary(task, all);
      const only = waiting[0]!;
      const requireDone = wait?.kind === "one" && wait.requireDone;
      if (requireDone)
        return translate("tasks:queue.oneDone", { title: only.title, who });
      // It goes on from that task's branch when the host derives its base from it.
      const branch = task.workspace?.base === `eta/task-${only.number}`;
      return translate(branch ? "tasks:queue.oneBranch" : "tasks:queue.one", {
        title: only.title,
        who,
      });
    }
    // How many it waits for in all: the board's own count (`waitSummary`).
    const wait = waitSummary(task, all);
    return translate("tasks:queue.many", {
      count: wait?.kind === "many" ? wait.total : waiting.length,
      titles: waiting.map((w) => `「${w.title}」`).join(""),
    });
  }
  if (machine?.reason === "machine_full") {
    const name = machine.name ?? translate("tasks:queueReason.thisMachine");
    const ready = (task.dependsOn ?? []).length > 0 || waitsOf(task).length > 0;
    const room =
      machine.max === undefined
        ? translate("tasks:queue.fullUnknown", { machine: name })
        : translate("tasks:queue.full", { machine: name, count: machine.max });
    return ready ? `${translate("tasks:queue.depsReady")}${room}` : room;
  }
  if (machine?.reason === "machine_offline")
    return translate("tasks:queue.offline", {
      machine: machine.name ?? translate("tasks:queueReason.thisMachine"),
    });
  return undefined;
}

/** How one end of the flow bar stands, in a word or two. */
export function flowWord(
  side: "before" | "after",
  edge: { status: Task["status"]; state: "resolved" | "waiting" | "cancelled" },
): string {
  if (side === "after")
    return translate(
      edge.state === "resolved"
        ? "tasks:flow.released"
        : "tasks:flow.waitsForThis",
    );
  if (edge.state === "cancelled") return translate("tasks:flow.cancelled");
  if (edge.status === "in_review") return translate("tasks:flow.delivered");
  if (edge.status === "done") return translate("tasks:flow.done");
  if (edge.status === "in_progress") return translate("tasks:flow.running");
  return statusLabel(edge.status);
}

/**
 * The part of a queue sentence that is set in bold: up to its colon, full-width in Chinese or ": "
 * in English; undefined for a sentence with none.
 */
export const sentenceLead = (sentence: string): string | undefined =>
  /^[^：:]+(?:：|: )/.exec(sentence)?.[0];
