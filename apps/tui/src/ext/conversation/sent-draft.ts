/** A message that could not be sent, as the composer shows it again. */
import type { Draft, FoldedPaste } from "./composer";
import type { PasteRange } from "./contract";
import { placeholderLabel } from "./composer/paste";

/** The draft that sends as `text` with `pastes`: each paste folded back into a placeholder. */
export function sentDraft(text: string, pastes: readonly PasteRange[]): Draft {
  let draft = "";
  let copied = 0;
  const folded: FoldedPaste[] = [];
  pastes.forEach(([start, end], index) => {
    draft += text.slice(copied, start);
    const content = text.slice(start, end);
    const number = index + 1;
    const label = placeholderLabel(number, content.split("\n").length);
    folded.push({
      start: draft.length,
      end: draft.length + label.length,
      number,
      content,
    });
    draft += label;
    copied = end;
  });
  draft += text.slice(copied);
  return { text: draft, pastes: folded };
}
