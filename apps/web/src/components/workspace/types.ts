/**
 * The right panel's tabs. One set, on every conversation: what this group is made of, what it is
 * working on, what it runs on a clock, what is waiting on you, and what it produced.
 *
 * `overview` is not one of them — "across every group" is not a fact about this one, so it stays
 * the single global page.
 */
export type WorkspaceView =
  | "context"
  | "tasks"
  | "routines"
  | "inbox"
  | "artifacts";
