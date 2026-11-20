/**
 * The status groupings live in `apps/eta/src/tasks/status.ts`. There, `MEANING` is a
 * `Record<BoardTaskStatus, …>`, so a new status fails the type check until it has a row; this
 * file pins what each row means.
 */
import { TASK_STATUSES } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import {
  finished,
  isActive,
  reviewedOrDone,
  workable,
} from "../src/tasks/status";

describe("task status partitions", () => {
  it("classifies every status in TASK_STATUSES", () => {
    expect(TASK_STATUSES.filter(isActive)).toEqual(["todo", "in_progress"]);
    expect(TASK_STATUSES.filter(reviewedOrDone)).toEqual(["in_review", "done"]);
    expect(TASK_STATUSES.filter(workable)).toEqual([
      "todo",
      "in_progress",
      "in_review",
      "blocked",
    ]);
    expect(TASK_STATUSES.filter(finished)).toEqual(["done", "cancelled"]);
  });
});
