/**
 * One line saying what a tool call is doing.
 *
 * The arguments are a JSON object; a collapsed row cannot show it, and showing the key names would
 * say less than the values do. eta-old's rule: take the first string value and cut it at 60
 * characters — "grep(block → 'unique key')" is a sentence, "grep({pattern: 'unique key', path:
 * 'src'})" is a form.
 *
 * The keys a person cares about most are looked for first, because `{command, timeout}` should
 * quote the command rather than the timeout.
 */
const PREFERRED = [
  "command",
  "path",
  "file_path",
  "file",
  "pattern",
  "query",
  "url",
  "goal",
  "text",
  // `show_widget`'s other argument is the widget's JSONL, which reads as noise in a row.
  "title",
];

export function summarizeArgs(args: unknown, limit = 60): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return cut(args, limit);
  if (typeof args !== "object") return cut(String(args), limit);
  const record = args as Record<string, unknown>;
  for (const key of PREFERRED) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0)
      return cut(value, limit);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim().length > 0)
      return cut(value, limit);
  }
  return "";
}

function cut(text: string, limit: number): string {
  // Newlines become spaces: a multi-line command in a one-line row is a broken layout.
  const squashed = text.trim().replace(/\s+/g, " ");
  return squashed.length <= limit ? squashed : `${squashed.slice(0, limit)}…`;
}
