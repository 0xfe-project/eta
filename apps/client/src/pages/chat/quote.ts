/** `selected` as a Markdown quote after `draft`, with a blank line around it so
 * the reader types below it; quotes added one after another stay apart. */
export function appendQuote(draft: string, selected: string): string {
  const text = selected.trim();
  if (!text) return draft;
  const quote = text
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  const before = draft.trimEnd();
  return `${before ? `${before}\n\n` : ""}${quote}\n\n`;
}
