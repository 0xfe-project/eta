/**
 * What a tool call is, in akhook's terms (the "adapter" half of akhook: `agents/*.rs`).
 *
 * Every call is a `tool_call` candidate. eta's own `edit` and `write` tools also produce a
 * `file_change` candidate carrying what the change *introduces*, so a rule is not tripped by
 * something that was already in the file. Calls of tools named by `shell_tools` are turned into
 * `shell_exec` candidates by the rule set.
 */
import type { Candidate } from "./rules";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The lines of `after` that `before` does not already contain (as a multiset). */
export function introducedLines(before: string, after: string): string {
  const available = new Map<string, number>();
  for (const line of before.split("\n"))
    available.set(line, (available.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const left = available.get(line) ?? 0;
    if (left > 0) available.set(line, left - 1);
    else added.push(line);
  }
  return added.join("\n");
}

interface EditPair {
  oldText: string;
  newText: string;
}

/** The replacements of an `edit` call: `edits[]`, or the legacy single `oldText`/`newText`. */
function editPairs(args: Record<string, unknown>): EditPair[] {
  const pairs: EditPair[] = [];
  const list = Array.isArray(args.edits) ? args.edits : [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const edit = item as Record<string, unknown>;
    if (typeof edit.newText === "string")
      pairs.push({
        oldText: typeof edit.oldText === "string" ? edit.oldText : "",
        newText: edit.newText,
      });
  }
  if (typeof args.newText === "string")
    pairs.push({
      oldText: typeof args.oldText === "string" ? args.oldText : "",
      newText: args.newText,
    });
  return pairs;
}

const MAX_OLD_FILE_BYTES = 1_000_000;

function oldContent(path: string): string | undefined {
  try {
    if (!existsSync(path) || statSync(path).size > MAX_OLD_FILE_BYTES)
      return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The candidates of one call of tool `name` with `args`, in a session working in `cwd`. */
export function candidatesOf(
  name: string,
  args: unknown,
  cwd: string,
): Candidate[] {
  const candidates: Candidate[] = [{ type: "tool_call", name, args }];
  if (typeof args !== "object" || args === null) return candidates;
  const record = args as Record<string, unknown>;
  const rawPath = record.path;
  if (typeof rawPath !== "string" || rawPath === "") return candidates;
  const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  if (name === "edit") {
    const pairs = editPairs(record);
    if (pairs.length === 0) return candidates;
    const oldText = pairs.map((pair) => pair.oldText).join("\n");
    const newText = pairs.map((pair) => pair.newText).join("\n");
    candidates.push({
      type: "file_change",
      path,
      action: "modify",
      added_text: introducedLines(oldText, newText),
      new_text: newText,
      old_text: oldText,
    });
  } else if (name === "write" && typeof record.content === "string") {
    const before = oldContent(path);
    candidates.push({
      type: "file_change",
      path,
      action: before === undefined && !existsSync(path) ? "create" : "modify",
      added_text:
        before === undefined
          ? record.content
          : introducedLines(before, record.content),
      new_text: record.content,
      old_text: before ?? "",
    });
  }
  return candidates;
}
