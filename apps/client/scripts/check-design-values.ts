// Design values (spacing, sizes, weights, colours, text sizes) come from the tokens: tokens.ts,
// the palette in theme.ts and the type scale. The rules are ast-grep's (sgconfig.yml,
// lint/ast-grep/rules); this script adds what ast-grep cannot say:
//
// - A line may keep its own value when it says why: `// design-value: <reason>` on the line, or
//   alone on the line above. A `design-value:` without a reason does not count.
// - What was there before this lint is in the baseline (lint/design-values-baseline.json), as a
//   count per rule and file. A file may not have more than its count: a new value fails. A file
//   with fewer fails too, until the baseline is brought down with it (`bun run lint:baseline`),
//   so the baseline only shrinks. Its changes against main are printed.
//
//   bun scripts/check-design-values.ts            check
//   bun scripts/check-design-values.ts --update   write the baseline (never raises a count)
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dir, "..");
const baselinePath = join(root, "lint", "design-values-baseline.json");
const baselineInRepo = "apps/client/lint/design-values-baseline.json";

type Counts = Record<string, Record<string, number>>;

interface Match {
  ruleId: string;
  file: string;
  message: string;
  lines: string;
  range: { start: { line: number }; end: { line: number } };
}

/** The ast-grep binary itself, not its npm wrapper (which spawns it through Node). */
function astGrep(): string {
  const require = createRequire(join(root, "package.json"));
  try {
    const { resolveBinaryPath } = require("@ast-grep/cli/postinstall") as {
      resolveBinaryPath: () => string;
    };
    return resolveBinaryPath();
  } catch {
    return join(root, "node_modules", ".bin", "ast-grep");
  }
}

function scan(): Match[] {
  const result = spawnSync(
    astGrep(),
    ["scan", "--json=stream", "src", "App.tsx"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr);
    throw new Error(`ast-grep exited with ${result.status}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Match);
}

const allowance = /(?:\/\/|\/\*|\{\/\*)\s*design-value:(.*)$/;

/** Whether a line lets `match` keep its value, or why the allowance does not count. */
function allowed(
  match: Match,
  lines: string[],
): { ok: true } | { ok: false; reason?: string } {
  const first = match.range.start.line;
  const candidates = [lines[first] ?? ""];
  // A comment alone on the line above (dprint moves a long trailing comment nowhere, but a
  // multi-line value reads better with it above).
  const above = lines[first - 1] ?? "";
  if (/^\s*(?:\/\/|\/\*|\{\/\*)/.test(above)) candidates.push(above);
  for (const line of candidates) {
    const found = allowance.exec(line);
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

const files = new Map<string, string[]>();
const linesOf = (file: string) => {
  let lines = files.get(file);
  if (!lines) {
    lines = readFileSync(join(root, file), "utf8").split("\n");
    files.set(file, lines);
  }
  return lines;
};

const found: Match[] = [];
const unreasoned: string[] = [];
for (const match of scan()) {
  const verdict = allowed(match, linesOf(match.file));
  if (verdict.ok) continue;
  if (verdict.reason) {
    unreasoned.push(
      `${match.file}:${match.range.start.line + 1}: ${verdict.reason}`,
    );
  }
  found.push(match);
}

const counts: Counts = {};
for (const match of found) {
  const rule = (counts[match.ruleId] ??= {});
  rule[match.file] = (rule[match.file] ?? 0) + 1;
}

function sorted(c: Counts): Counts {
  return Object.fromEntries(
    Object.keys(c)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(
          Object.entries(c[rule]!)
            .filter(([, n]) => n > 0)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
  );
}

const read = (text: string | undefined): Counts =>
  text ? (JSON.parse(text) as { counts: Counts }).counts : {};

const total = (c: Counts, rule: string) =>
  Object.values(c[rule] ?? {}).reduce((sum, n) => sum + n, 0);

/** Per rule and file, what changed from `before` to `after`. */
function changes(before: Counts, after: Counts) {
  const out: { rule: string; file: string; from: number; to: number }[] = [];
  for (const rule of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const keys = new Set([
      ...Object.keys(before[rule] ?? {}),
      ...Object.keys(after[rule] ?? {}),
    ]);
    for (const file of [...keys].sort()) {
      const from = before[rule]?.[file] ?? 0;
      const to = after[rule]?.[file] ?? 0;
      if (from !== to) out.push({ rule, file, from, to });
    }
  }
  return out;
}

function printChanges(title: string, before: Counts, after: Counts) {
  const list = changes(before, after);
  if (!list.length) return;
  console.log(title);
  for (const rule of new Set(list.map((c) => c.rule))) {
    console.log(`  ${rule}: ${total(before, rule)} → ${total(after, rule)}`);
    for (const c of list.filter((c) => c.rule === rule)) {
      const sign = c.to > c.from ? "+" : "";
      console.log(
        `    ${sign}${c.to - c.from}  ${c.file} (${c.from} → ${c.to})`,
      );
    }
  }
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** Where this branch left main; undefined when git cannot say (no origin/main). */
const base = (() => {
  try {
    return git("merge-base", "HEAD", "origin/main");
  } catch {
    return undefined;
  }
})();

/** The baseline on main (where this branch left it): null when main has none yet, undefined when
 * git cannot say. */
function baselineOnMain(): Counts | null | undefined {
  if (!base) return undefined;
  try {
    return read(git("show", `${base}:${baselineInRepo}`));
  } catch {
    return null;
  }
}

let text: string | undefined;
try {
  text = readFileSync(baselinePath, "utf8");
} catch {}
const baseline = read(text);
const current = sorted(counts);

if (process.argv.includes("--update")) {
  const raised = text
    ? changes(baseline, current).filter((c) => c.to > c.from)
    : [];
  if (raised.length && !process.argv.includes("--allow-increase")) {
    console.error(
      "The baseline only shrinks. These have more design values than it allows:",
    );
    for (const c of raised)
      console.error(`  ${c.rule}  ${c.file}: ${c.from} → ${c.to}`);
    console.error(
      "Take them from the tokens, or give the line a `// design-value: <reason>`. A file that only moved: --allow-increase.",
    );
    process.exit(1);
  }
  writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        $comment:
          "Design values written before the lint, per rule and file. Only shrinks: `bun run lint:baseline` after moving some to tokens (scripts/check-design-values.ts).",
        counts: current,
      },
      null,
      2,
    )}\n`,
  );
  printChanges("Baseline updated:", baseline, current);
  process.exit(0);
}

/** The lines of `file` this branch added or changed since main (since HEAD without main), all of
 * an untracked file's; undefined when git cannot say. */
function changedLines(file: string): Set<number> | undefined {
  try {
    const diff = git("diff", "-U0", "--no-color", base ?? "HEAD", "--", file);
    const tracked = git("ls-files", "--", file);
    if (!tracked) return new Set(linesOf(file).map((_, i) => i + 1));
    const lines = new Set<number>();
    for (const hunk of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1]);
      const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let l = start; l < start + length; l++) lines.add(l);
    }
    return lines;
  } catch {
    return undefined;
  }
}

const problems: string[] = [...unreasoned];
const stale: string[] = [];
for (const rule of new Set([
  ...Object.keys(baseline),
  ...Object.keys(current),
])) {
  const byFile = new Set([
    ...Object.keys(baseline[rule] ?? {}),
    ...Object.keys(current[rule] ?? {}),
  ]);
  for (const file of byFile) {
    const allowedCount = baseline[rule]?.[file] ?? 0;
    const count = current[rule]?.[file] ?? 0;
    if (count > allowedCount) {
      const here = found.filter((m) => m.ruleId === rule && m.file === file);
      // The ones on lines changed since the last commit, when git can tell; else all of them.
      const changed = changedLines(file);
      const fresh = changed
        ? here.filter((m) => {
            for (let l = m.range.start.line; l <= m.range.end.line; l++)
              if (changed.has(l + 1)) return true;
            return false;
          })
        : [];
      const shown = fresh.length ? fresh : here;
      problems.push(
        `${file}: ${count} ${rule} where the baseline allows ${allowedCount}; ${
          fresh.length
            ? "on the lines this branch changed"
            : "new ones are among"
        }:\n${shown
          .map(
            (m) =>
              `  ${m.file}:${m.range.start.line + 1}  ${m.lines.split("\n")[0]!.trim()}\n    ${m.message}`,
          )
          .join("\n")}`,
      );
    } else if (count < allowedCount) {
      stale.push(`  ${rule}  ${file}: ${allowedCount} → ${count}`);
    }
  }
}

const main = baselineOnMain();
if (main === null) {
  console.log(
    `No baseline on main yet; this one allows ${Object.keys(baseline)
      .map((rule) => `${total(baseline, rule)} ${rule}`)
      .join(", ")}.`,
  );
} else if (main) {
  printChanges("The baseline against main:", main, baseline);
  const grown = Object.keys(baseline).filter(
    (rule) => total(baseline, rule) > total(main, rule),
  );
  for (const rule of grown) {
    problems.push(
      `The baseline allows more ${rule} than on main (${total(main, rule)} → ${total(baseline, rule)}); it only shrinks.`,
    );
  }
}

if (stale.length) {
  problems.push(
    `Fewer design values than the baseline: bring it down with \`bun run lint:baseline\`.\n${stale.join("\n")}`,
  );
}

if (problems.length) {
  console.error(
    `Design values come from tokens.ts, the palette and the type scale (src/components/theme.ts):\n\n${problems.join("\n\n")}`,
  );
  process.exit(1);
}
