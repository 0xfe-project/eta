/** A reply's steps folded under one line: which of its items are steps, and what shows of them. */
import type { StepItem, TranscriptItem } from "../contract";

function isStep(item: TranscriptItem): item is StepItem {
  return (
    item.kind === "thinking" || item.kind === "text" || item.kind === "tool"
  );
}

/**
 * The items of one reply with its steps folded under a `steps` item keyed `key`. The steps are
 * the thinking, text and tool items from the first item up to the last tool call; the line
 * stands where the first of them stood. While `open`, every item stays after the line as it was;
 * otherwise the steps are left out and the other items (an outcome, a notice) stay in order. A
 * reply without a tool call comes back as it was.
 */
export function foldSteps(
  items: readonly TranscriptItem[],
  key: string,
  replying: boolean,
  open: boolean,
): TranscriptItem[] {
  const lastTool = items.map((item) => item.kind).lastIndexOf("tool");
  if (lastTool < 0) return [...items];
  const isFolded = (item: TranscriptItem, index: number): item is StepItem =>
    index <= lastTool && isStep(item);
  const steps = items.filter(isFolded);
  const line: TranscriptItem = { kind: "steps", key, steps, replying };
  const first = items.findIndex(isFolded);
  return items.flatMap((item, index) => {
    const shown = open || !isFolded(item, index) ? [item] : [];
    return index === first ? [line, ...shown] : shown;
  });
}
