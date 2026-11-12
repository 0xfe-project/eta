import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/gen-extensions.ts");
const roots: string[] = [];

function makeApp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "eta-tui-gen-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, "src", "ext", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  mkdirSync(join(root, "src", "ext"), { recursive: true });
  return root;
}

function generate(root: string) {
  return spawnSync(process.execPath, [script, "--root", root], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const module = (id: string) => `export default { id: "${id}" };\n`;

describe("gen-extensions", () => {
  it("imports every extension module, in file name order, and exports them as one list", async () => {
    const root = makeApp({
      "zeta.ts": module("zeta"),
      "alpha.tsx": module("alpha"),
      "mid/index.ts": module("mid"),
      "mid/helper.ts": "export const helper = 1;\n",
      "beta/index.tsx": module("beta"),
      "alpha.test.ts": "throw new Error('a test is not an extension');\n",
      "types.d.ts": "export {};\n",
    });
    const run = generate(root);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);

    const out = join(root, "src", "extensions.gen.ts");
    const text = readFileSync(out, "utf8");
    const imports = [...text.matchAll(/from "(\.\/ext\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(imports).toEqual([
      "./ext/alpha",
      "./ext/beta",
      "./ext/mid",
      "./ext/zeta",
    ]);
    expect(text).not.toMatch(/helper|\.test|types\.d/);

    const generated = (await import(pathToFileURL(out).href)) as {
      extensions: { id: string }[];
    };
    expect(generated.extensions.map((e) => e.id)).toEqual([
      "alpha",
      "beta",
      "mid",
      "zeta",
    ]);
  });

  it("fails, naming the module, when one name is both a file and a directory", () => {
    const root = makeApp({
      "twice.ts": module("twice"),
      "twice/index.ts": module("twice"),
    });
    const run = generate(root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/twice/);
  });
  it("leaves the file alone when its content would not change, and rewrites it when it would", () => {
    const root = makeApp({ "a.ts": module("a") });
    expect(generate(root).status).toBe(0);
    const out = join(root, "src", "extensions.gen.ts");
    // An old modification time: a rewrite, even with the same bytes, would move it.
    const old = new Date("2001-01-01T00:00:00Z");
    utimesSync(out, old, old);
    expect(generate(root).status).toBe(0);
    expect(statSync(out).mtimeMs).toBe(old.getTime());

    writeFileSync(join(root, "src", "ext", "b.ts"), module("b"));
    expect(generate(root).status).toBe(0);
    expect(statSync(out).mtimeMs).not.toBe(old.getTime());
    expect(readFileSync(out, "utf8")).toContain('from "./ext/b"');
  });
});
