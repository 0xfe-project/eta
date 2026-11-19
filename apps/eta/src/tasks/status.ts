import type { BoardTaskStatus } from "@eta/client-contracts";

/**
 * What a task's status means, on the host. The words themselves are the board's (`TASK_STATUSES`
 * in client-contracts); this table is the host's reading of them, and the `Record` makes a new
 * status a compile error until it is given a row.
 */
interface Meaning {
  /** In flight: someone is meant to be working it. */
  active: boolean;
  /** Satisfies a dependency that only needs a review. */
  reviewed: boolean;
  /** An executor may work a task in this status. */
  workable: boolean;
}

const MEANING: Record<BoardTaskStatus, Meaning> = {
  backlog: { active: false, reviewed: false, workable: false },
  todo: { active: true, reviewed: false, workable: true },
  in_progress: { active: true, reviewed: false, workable: true },
  in_review: { active: false, reviewed: true, workable: true },
  done: { active: false, reviewed: true, workable: false },
  blocked: { active: false, reviewed: false, workable: true },
  cancelled: { active: false, reviewed: false, workable: false },
};

export const isActive = (status: BoardTaskStatus): boolean =>
  MEANING[status].active;

export const reviewedOrDone = (status: BoardTaskStatus): boolean =>
  MEANING[status].reviewed;

/**
 * Whether a task in this status is one an executor works on. It answers two questions at once:
 * does a change to this task set a run going, and does a comment on it wake one. A task in the
 * backlog is not claimed yet, and one that is done or cancelled has nothing more to do with it:
 * those comments are recorded and read by whoever looks.
 */
export const workable = (status: BoardTaskStatus): boolean =>
  MEANING[status].workable;

/** Done or cancelled: the statuses a task can be archived in by itself. */
export const finished = (status: BoardTaskStatus): boolean =>
  status === "done" || status === "cancelled";
