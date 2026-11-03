import type { ToolBlock } from "./run";
import { createPatch } from "diff";
import { commandOf } from "./run";

// What a tool call was, read from the shape of what it was called with rather than from its name:
// Claude Code's `Edit`, eta's `edit` and Codex's `fileChange` are one thing to a reader (a file
// changed), and a runtime that names its tools differently still says `command` or `file_path`.

/** One file a call changed, as a unified diff. */
export interface FilePatch {
  path: string;
  /** What happened to the file: a Codex change says add, delete or update. */
  change?: "add" | "delete" | "update" | undefined;
  patch: string;
}

/** One planned step, from a to-do list a call wrote or a task tool's answer. */
export interface PlanItem {
  content: string;
  status: string;
}

/** One step a runtime's subagent took inside a call (see `details.children`). */
export type ChildStep =
  | {
      kind: "tool";
      id: string;
      name: string;
      input?: string;
      status: "running" | "completed" | "failed";
      output?: string;
      outputTruncated?: true;
      exitCode?: number | null;
    }
  | { kind: "text"; text: string };

/** Work a runtime tracked beside the call (a background command, a subagent). */
export interface RuntimeTask {
  type: string;
  description?: string;
  background?: boolean;
  status?: string;
  summary?: string;
  outputFile?: string;
}

export type ToolShape =
  | { kind: "command"; command: string }
  | { kind: "patch"; files: FilePatch[] }
  | { kind: "write"; path: string; content: string }
  | { kind: "plan"; items: PlanItem[] }
  | { kind: "other" };

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** The shape a call's input (and, for an edit, its result's details) says it has. */
export function shapeOf(block: ToolBlock): ToolShape {
  const input = block.input;
  const details = isRecord(block.details) ? block.details : {};
  const command =
    commandOf(input) ??
    (block.name === "commandExecution" && isRecord(input)
      ? str(input.input)
      : undefined);
  if (command !== undefined) return { kind: "command", command };
  if (!isRecord(input)) return { kind: "other" };
  const path = str(input.file_path) ?? str(input.path) ?? "";

  // eta's own edit keeps the patch it applied.
  const applied = str(details.patch);
  if (applied !== undefined && applied !== "")
    return { kind: "patch", files: [{ path, patch: applied }] };
  // Claude Code's Edit and MultiEdit, and eta's edit before its result is back.
  const pairs = editPairs(input);
  if (pairs.length > 0)
    return {
      kind: "patch",
      files: [
        {
          path,
          patch: pairs
            .map(([before, after]) => hunks(path, before, after))
            .join("\n"),
        },
      ],
    };
  // Codex's fileChange: its input is the changes, as JSON text.
  const changes = codexChanges(input);
  if (changes.length > 0) return { kind: "patch", files: changes };
  const content = str(input.content);
  if (path !== "" && content !== undefined)
    return { kind: "write", path, content };
  const items = planItems(input, details);
  if (items.length > 0) return { kind: "plan", items };
  return { kind: "other" };
}

function editPairs(input: Fields): [string, string][] {
  const one = (edit: unknown): [string, string] | undefined => {
    if (!isRecord(edit)) return undefined;
    const before = str(edit.old_string) ?? str(edit.oldText);
    const after = str(edit.new_string) ?? str(edit.newText);
    return before === undefined || after === undefined
      ? undefined
      : [before, after];
  };
  const top = one(input);
  if (top !== undefined) return [top];
  return Array.isArray(input.edits)
    ? input.edits.flatMap((edit) => {
        const pair = one(edit);
        return pair === undefined ? [] : [pair];
      })
    : [];
}

/** The hunks of a unified diff between two texts, without the file header. */
function hunks(path: string, before: string, after: string): string {
  const patch = createPatch(path, before, after, "", "", { context: 3 });
  return patch.slice(patch.indexOf("@@"));
}

function codexChanges(input: Fields): FilePatch[] {
  const raw = input.input ?? input.changes;
  let changes: unknown = raw;
  if (typeof raw === "string") {
    try {
      changes = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (isRecord(changes))
    changes = Object.entries(changes).map(([path, change]) => ({
      ...(isRecord(change) ? change : {}),
      path,
    }));
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change): FilePatch[] => {
    if (!isRecord(change)) return [];
    const path = str(change.path);
    if (path === undefined) return [];
    const kind = isRecord(change.kind)
      ? str(change.kind.type)
      : str(change.kind);
    const patch =
      str(change.diff) ?? str(change.unified_diff) ?? str(change.content) ?? "";
    return [
      {
        path,
        change:
          kind === "add" || kind === "delete" || kind === "update"
            ? kind
            : undefined,
        patch,
      },
    ];
  });
}

function planItems(input: Fields, details: Fields): PlanItem[] {
  const item = (value: unknown): PlanItem | undefined => {
    if (!isRecord(value)) return undefined;
    const content = str(value.content) ?? str(value.step) ?? str(value.subject);
    return content === undefined
      ? undefined
      : { content, status: str(value.status) ?? "pending" };
  };
  const list = (value: unknown) =>
    Array.isArray(value) ? value.flatMap((entry) => item(entry) ?? []) : [];
  // Claude Code's TodoWrite, Codex's update_plan.
  const written = list(input.todos ?? input.plan);
  if (written.length > 0) return written;
  // eta's step tools answer with the step, or the whole list.
  const listed = list(details.tasks);
  if (listed.length > 0) return listed;
  const one = item(details.task);
  return one === undefined ? [] : [one];
}

/** How many lines a patch adds and removes. */
export function patchCounts(files: readonly FilePatch[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const file of files)
    for (const line of file.patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  return { added, removed };
}

/** The exit code a command reported, when it reported one. */
export function exitCodeOf(block: ToolBlock): number | null | undefined {
  if (!isRecord(block.details)) return undefined;
  const code = block.details.exitCode;
  return typeof code === "number" || code === null ? code : undefined;
}

/** Where a command's whole output went when what it printed was cut. */
export function fullOutputOf(block: ToolBlock): string | undefined {
  if (!isRecord(block.details)) return undefined;
  const truncation = block.details.truncation;
  const truncated = isRecord(truncation) && truncation.truncated === true;
  const path = str(block.details.fullOutputPath);
  return truncated || path !== undefined ? (path ?? "") : undefined;
}

export function childrenOf(block: ToolBlock): ChildStep[] {
  if (!isRecord(block.details) || !Array.isArray(block.details.children))
    return [];
  return block.details.children.filter(
    (child): child is ChildStep =>
      isRecord(child) &&
      ((child.kind === "tool" && typeof child.name === "string") ||
        (child.kind === "text" && typeof child.text === "string")),
  );
}

export function runtimeTaskOf(block: ToolBlock): RuntimeTask | undefined {
  if (!isRecord(block.details)) return undefined;
  const task = block.details.runtimeTask;
  return isRecord(task) && typeof task.type === "string"
    ? (task as unknown as RuntimeTask)
    : undefined;
}

/** A terminal's colour and cursor codes, which read as noise outside one. */
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\u001B\[[\d;?]*[\u0020-\u002F]*[\u0040-\u007E]|\u001B\][^\u0007]*\u0007/g;

export function withoutAnsi(text: string): string {
  return text.replace(ANSI, "");
}
