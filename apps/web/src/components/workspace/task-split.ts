import type { NewTaskArgs } from "@eta/client-contracts";

// "Split into subtasks": one subtask a line. A line that starts with an arrow ("→", or "->")
// begins the next step and waits for every line of the step before it; a line without one sits
// in the same step as the line above it, side by side with it, waiting for what that one waits
// for. So
//
//     Changelog
//     Docs
//     → Regression
//     → Announce
//
// is three steps: Changelog and Docs side by side, then Regression (after both), then Announce.

export interface SplitLine {
  title: string;
  /** Its step, from 1. */
  step: number;
  /** The lines it waits for, by index. */
  after: number[];
}

const ARROW = /^\s*(?:→|->|=>)\s*/;

export function parseSplit(text: string): SplitLine[] {
  const lines: SplitLine[] = [];
  let step: number[] = [];
  let before: number[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const arrow = ARROW.test(raw);
    const title = raw.replace(ARROW, "").trim();
    if (title === "") continue;
    // The first line has nothing before it to wait for, arrow or not.
    if (arrow && step.length > 0) {
      before = step;
      step = [];
    }
    const index = lines.length;
    lines.push({ title, step: 1, after: [...before] });
    step.push(index);
  }
  // Steps from the waits: one after the latest line it waits for.
  for (const line of lines)
    line.step =
      line.after.length === 0
        ? 1
        : Math.max(...line.after.map((i) => lines[i]!.step)) + 1;
  return lines;
}

/** How many lines each step has, in order: what the preview says. */
export const stepSizes = (lines: readonly SplitLine[]): number[] => {
  const sizes: number[] = [];
  for (const line of lines)
    sizes[line.step - 1] = (sizes[line.step - 1] ?? 0) + 1;
  return sizes;
};

/**
 * The batch `tasks.create` is sent: the lines as subtasks of an existing task (`parent` is then
 * the call's), or, with `top`, under a new task made first in the same write.
 */
export function splitBatch(
  lines: readonly SplitLine[],
  assignee: string,
  top?: { title: string; description?: string },
): NewTaskArgs[] {
  const shift = top === undefined ? 0 : 1;
  const subtasks = lines.map(
    (line): NewTaskArgs => ({
      title: line.title,
      assignee,
      ...(line.after.length === 0
        ? {}
        : { after: line.after.map((i) => i + shift) }),
      ...(top === undefined ? {} : { under: 0 }),
    }),
  );
  return top === undefined
    ? subtasks
    : [
        { title: top.title, description: top.description, assignee },
        ...subtasks,
      ];
}
