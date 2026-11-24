import type {
  BoardTaskStatus,
  TaskStepStatus,
  TaskStepView,
} from "@eta/client-contracts";

/** The board status whose mark reads as each step status. */
const glyphs: Record<TaskStepStatus, BoardTaskStatus> = {
  pending: "todo",
  in_progress: "in_progress",
  completed: "done",
  cancelled: "cancelled",
};

/** A plan as the rail draws it: undefined (nothing to draw) for no steps, else its rows in order and how many are done. */
export function stepRows(steps: TaskStepView[] | undefined) {
  if (!steps?.length) return undefined;
  return {
    completed: steps.filter((step) => step.status === "completed").length,
    total: steps.length,
    rows: steps.map((step) => ({ ...step, glyph: glyphs[step.status] })),
  };
}
