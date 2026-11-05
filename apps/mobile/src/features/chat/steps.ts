// A reply's steps in human words (03, 03h, 04): what it read, changed, ran, was stopped from.

import type { ToolBlock } from "./run";
import { t } from "../../i18n";
import { exitCodeOf, patchCounts, shapeOf } from "./tool-shape";

export interface Step {
  id: string;
  verb: string;
  /** What it was done to: a path, a command, a query. */
  text: string;
  added?: number;
  removed?: number;
  /** A short outcome after the text: `51 pass`, `退出 1`. */
  note?: string;
  /** `全过`, said where 04 has room for a word instead of the numbers. */
  verdict?: string;
  /** A tool the host stopped, or a command that failed. */
  failed: boolean;
  refused: boolean;
  block: ToolBlock;
}

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
];

/** One line of what a call was about: the first value a person would say. See web's `summarizeArgs`. */
export function summarize(args: unknown, limit = 60): string {
  const cut = (text: string) => {
    const squashed = text.trim().replace(/\s+/g, " ");
    return squashed.length <= limit ? squashed : `${squashed.slice(0, limit)}…`;
  };
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return cut(args);
  if (typeof args !== "object") return cut(String(args));
  const record = args as Record<string, unknown>;
  for (const key of PREFERRED) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return cut(value);
  }
  for (const value of Object.values(record))
    if (typeof value === "string" && value.trim().length > 0) return cut(value);
  return "";
}

/** The kernel's words for a call a hook stopped (`blocked by <hook>: <reason>`). */
const isRefused = (block: ToolBlock) =>
  block.status === "failed" && (block.output ?? "").startsWith("blocked by ");

/** The numbers a test runner printed last: `51 pass`, when it printed any. */
function testResult(
  output: string | undefined,
): { passed: number; failed: number } | undefined {
  if (output === undefined) return undefined;
  const passed = [...output.matchAll(/(\d+)\s+pass(?:ed)?\b/g)].at(-1);
  if (passed === undefined) return undefined;
  const failed = [...output.matchAll(/(\d+)\s+fail(?:ed)?\b/g)].at(-1);
  return { passed: Number(passed[1]), failed: Number(failed?.[1] ?? 0) };
}

const lines = (text: string) =>
  text.split("\n").filter((line) => line.trim() !== "").length;

export function stepOf(block: ToolBlock): Step {
  const base = {
    id: block.id,
    block,
    refused: false,
    failed: block.status === "failed",
  };
  const shape = shapeOf(block);
  if (isRefused(block))
    return {
      ...base,
      refused: true,
      verb: t("chat.step.refused"),
      text:
        shape.kind === "command"
          ? shape.command
          : summarize(block.input) || block.name,
    };
  if (shape.kind === "command") {
    const code = exitCodeOf(block);
    const tests = testResult(block.output);
    const failed =
      block.status === "failed" || (typeof code === "number" && code !== 0);
    return {
      ...base,
      failed,
      verb: t("chat.step.ran"),
      text: summarize(shape.command, 200),
      ...(failed
        ? { note: t("chat.tool.exit", { code: code ?? "?" }) }
        : tests === undefined
          ? {}
          : {
              note: t("chat.step.passed", { count: tests.passed }),
              ...(tests.failed === 0
                ? { verdict: t("chat.step.allPassed") }
                : {}),
            }),
    };
  }
  if (shape.kind === "patch") {
    const { added, removed } = patchCounts(shape.files);
    const [first] = shape.files;
    return {
      ...base,
      verb: t("chat.step.changed"),
      text:
        shape.files.length > 1
          ? `${first?.path ?? ""} +${shape.files.length - 1}`
          : (first?.path ?? ""),
      added,
      removed,
    };
  }
  if (shape.kind === "write")
    return {
      ...base,
      verb: t("chat.step.wrote"),
      text: shape.path,
      added:
        shape.content === ""
          ? 0
          : shape.content.replace(/\n$/, "").split("\n").length,
    };
  if (shape.kind === "plan")
    return {
      ...base,
      verb: t("chat.step.planned"),
      text: t("chat.step.planItems", { count: shape.items.length }),
    };
  const name = block.name.toLowerCase();
  const what = summarize(block.input);
  if (/grep|glob|search|find/.test(name)) {
    const hits = block.output === undefined ? undefined : lines(block.output);
    return {
      ...base,
      verb: t("chat.step.searched"),
      text:
        hits === undefined
          ? `“${what}”`
          : t("chat.step.searchHits", { query: what, count: hits }),
    };
  }
  if (name === "ask_user")
    return { ...base, verb: t("chat.step.asked"), text: what };
  if (/read|cat|view|fetch|open/.test(name) && what !== "")
    return { ...base, verb: t("chat.step.read"), text: what };
  return {
    ...base,
    verb: t("chat.step.called"),
    text: what === "" ? block.name : `${block.name} ${what}`,
  };
}

/** A step as one line of text, for the box in a group's reply. */
export function sentence(step: Step): string {
  return [
    step.verb,
    step.text,
    step.added ? `+${step.added}` : "",
    step.removed ? `−${step.removed}` : "",
    step.note ?? "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}
