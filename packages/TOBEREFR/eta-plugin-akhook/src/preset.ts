/**
 * The `omp` preset: oh-my-pi's 27 built-in rules, as `stream` rules.
 *
 * akhook maps these to a refusal before the tool runs, because a hook cannot touch the model's
 * loop. eta can, so the rules keep what omp gave them: they watch the stream, and each carries
 * its own `interruptMode` (all 27 are `never`: the tool runs, and the reminder rides with its
 * result). The sources are akhook's copies of omp v18.2.11 (`presets/omp/*.md`, MIT, see the
 * LICENSE next to them), embedded by `scripts/embed-presets.ts`.
 */
import type { InterruptMode, RuleSpec } from "./types";
import { parse as parseYaml } from "yaml";
import { OMP_PRESET } from "./omp-preset.gen";
import { ConfigError } from "./types";

interface Frontmatter {
  condition?: string | string[];
  astCondition?: string | string[];
  scope?: string | string[];
  interruptMode?: InterruptMode;
}

/** Split `a, b(c,d), e{f,g}` at the commas that are not inside parentheses or braces. */
export function splitScope(scope: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < scope.length; index++) {
    const char = scope[index];
    if (char === "(" || char === "{") depth++;
    else if (char === ")" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(scope.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(scope.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

const list = (value: string | string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;

/** The ast-grep language of a preset rule, from its name prefix (akhook's mapping). */
function languageOf(name: string): string {
  if (name.startsWith("go-")) return "go";
  if (name.startsWith("rs-")) return "rust";
  return "tsx";
}

/** One omp Markdown rule as a `stream` rule. */
export function ompRule(name: string, markdown: string): RuleSpec {
  const source = markdown.startsWith("---\n") ? markdown.slice(4) : undefined;
  const end = source?.indexOf("\n---\n") ?? -1;
  if (source === undefined || end < 0)
    throw new ConfigError(`omp/${name}: missing or unterminated frontmatter`);
  const front = (parseYaml(source.slice(0, end)) ?? {}) as Frontmatter;
  const body = source.slice(end + "\n---\n".length).trim();
  const checks: RuleSpec["checks"] = [
    ...list(front.condition).map((regex) => ({ regex })),
    ...list(front.astCondition).map((pattern) => ({
      ast: { language: languageOf(name), pattern },
    })),
  ];
  if (checks.length === 0) throw new ConfigError(`omp/${name}: no checks`);
  return {
    id: `omp/${name}`,
    on: "stream",
    paths: [],
    actions: [],
    tools: [],
    checks,
    message: body,
    scope: list(front.scope).flatMap(splitScope),
    ...(front.interruptMode === undefined
      ? {}
      : { interrupt_mode: front.interruptMode }),
  };
}

/** All 27 rules of the preset, sorted by name. */
export function ompRules(): RuleSpec[] {
  return Object.entries(OMP_PRESET).map(([name, markdown]) =>
    ompRule(name, markdown),
  );
}
