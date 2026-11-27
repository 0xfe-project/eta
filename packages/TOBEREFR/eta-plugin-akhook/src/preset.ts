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

/** The frontmatter and body of one omp Markdown rule. */
function parseRule(
  name: string,
  markdown: string,
): { front: Frontmatter; body: string } {
  const source = markdown.startsWith("---\n") ? markdown.slice(4) : undefined;
  const end = source?.indexOf("\n---\n") ?? -1;
  if (source === undefined || end < 0)
    throw new ConfigError(`omp/${name}: missing or unterminated frontmatter`);
  return {
    front: (parseYaml(source.slice(0, end)) ?? {}) as Frontmatter,
    body: source.slice(end + "\n---\n".length).trim(),
  };
}

/** One omp Markdown rule as a `stream` rule. */
export function ompRule(name: string, markdown: string): RuleSpec {
  const { front, body } = parseRule(name, markdown);
  const checks: RuleSpec["checks"] = list(front.condition).map((regex) => ({
    regex,
  }));
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

/**
 * The rules of the preset that still have a check, sorted by name.
 *
 * Five of the upstream rules were written with `astCondition` alone. Structural matching is
 * gone (see NAPI-REMOVED.md), so those five have nothing left to match on and are left out
 * rather than packed as rules that can never fire.
 */
export const AST_ONLY_RULES: readonly string[] = [
  "go-bench-loop",
  "go-new-expr",
  "go-range-int",
  "ts-no-inline-cast-access",
  "ts-redundant-clear-guard",
];

export function ompRules(): RuleSpec[] {
  return Object.entries(OMP_PRESET)
    .filter(([name]) => !AST_ONLY_RULES.includes(name))
    .map(([name, markdown]) => ompRule(name, markdown));
}
