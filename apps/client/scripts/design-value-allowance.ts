export interface DesignValueMatch {
  ruleId: string;
  file: string;
  message: string;
  lines: string;
  range: { start: { line: number }; end: { line: number } };
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

const allowance = /(?:\/\/|\/\*|\{\/\*)\s*design-value:(.*)$/;

/** Whether a line lets `match` keep its value, or why the allowance does not count. */
export function allowed(
  match: Pick<DesignValueMatch, "range">,
  lines: string[],
): { ok: true } | { ok: false; reason?: string } {
  const first = match.range.start.line;
  const candidates = [lines[first] ?? ""];
  // A comment alone on the line above (dprint moves a long trailing comment nowhere, but a
  // multi-line value reads better with it above).
  const above = lines[first - 1] ?? "";
  if (/^\s*(?:\/\/|\/\*|\{\/\*)/.test(above)) candidates.push(above);
  for (const candidate of candidates) {
    const found = allowance.exec(candidate.replace(/\r$/, ""));
    if (!found) continue;
    const reason = found[1]!.replace(/\*\/\}?\s*$/, "").trim();
    if (reason) return { ok: true };
    return {
      ok: false,
      reason: "`design-value:` needs a reason after it",
    };
  }
  return { ok: false };
}
