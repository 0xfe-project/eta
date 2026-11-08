/**
 * A changed `extensions.gen.ts` is replaced whole: written beside it and renamed over it, so a
 * task reading it at the same moment sees the old file or the new one, never a truncated one.
 */
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/gen-extensions.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function makeApp(): string {
  const root = mkdtempSync(join(tmpdir(), "eta-tui-gen-"));
  roots.push(root);
  mkdirSync(join(root, "src", "ext"), { recursive: true });
  return root;
}

function generate(root: string) {
  return spawnSync(process.execPath, [script, "--root", root], {
    encoding: "utf8",
  });
}

const module = (id: string) => `export default { id: "${id}" };\n`;

describe("gen-extensions replacing a changed file", () => {
  it("leaves the old file whole for whoever still has it open, and leaves no temporary file behind", () => {
    const root = makeApp();
    writeFileSync(join(root, "src", "ext", "a.ts"), module("a"));
    expect(generate(root).status).toBe(0);
    const out = join(root, "src", "extensions.gen.ts");
    const before = readFileSync(out, "utf8");

    // A second name for the same file: a rewrite in place changes what it reads, a rename over
    // the first name does not.
    const reader = join(root, "reader.ts");
    linkSync(out, reader);

    writeFileSync(join(root, "src", "ext", "b.ts"), module("b"));
    const run = generate(root);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain('from "./ext/b"');
    expect(readFileSync(reader, "utf8")).toBe(before);
    expect(readdirSync(join(root, "src")).sort()).toEqual([
      "ext",
      "extensions.gen.ts",
    ]);
  });
});
