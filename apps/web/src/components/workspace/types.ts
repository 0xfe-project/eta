/**
 * The workspace's sections. Four are tabs of the right panel, one set on every conversation: what
 * this group is made of, what it is working on, what is waiting on you, and what it produced.
 *
 * `overview` is not one of them — "across every group" is not a fact about this one, so it stays
 * the single global page. `routines` is a section without a tab: a clock is not a fact about the
 * conversation you happen to be reading, so it stays a page of its own, and the links that want it
 * go there (see `sectionPaths`).
 */
export type WorkspaceView =
  | "context"
  | "tasks"
  | "routines"
  | "inbox"
  | "artifacts";
