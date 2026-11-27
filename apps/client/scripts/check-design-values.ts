// Design values (spacing, sizes, weights, colours, text sizes) come from the tokens: tokens.ts,
// the palette in theme.ts and the type scale. The rules are ast-grep's (sgconfig.yml,
// lint/ast-grep/rules); this script adds what ast-grep cannot say: a line may keep its own value
// when it says why, `// design-value: <reason>` on the line, or alone on the line above. A
// `design-value:` without a reason does not count. Every other match fails.
//
//   bun scripts/check-design-values.ts

import type { DesignValueMatch } from "./design-value-allowance";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { allowed, splitLines } from "./design-value-allowance";

const root = resolve(import.meta.dir, "..");

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

function scan(): DesignValueMatch[] {
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
  return splitLines(result.stdout)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DesignValueMatch);
}

const files = new Map<string, string[]>();
const linesOf = (file: string) => {
  let lines = files.get(file);
  if (!lines) {
    lines = splitLines(readFileSync(join(root, file), "utf8"));
    files.set(file, lines);
  }
  return lines;
};

const found: DesignValueMatch[] = [];
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

if (unreasoned.length || found.length) {
  const shown = found.map(
    (m) =>
      `${m.file}:${m.range.start.line + 1}  ${m.ruleId}  ${splitLines(m.lines)[0]!.trim()}\n    ${m.message}`,
  );
  console.error(
    `Design values come from tokens.ts, the palette and the type scale (src/components/theme.ts), or the line says why it keeps its own: \`// design-value: <reason>\`.\n\n${[...unreasoned, ...shown].join("\n")}`,
  );
  process.exit(1);
}
