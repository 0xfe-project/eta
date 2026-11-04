import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, snippetSource } from "../../src/realm";

const run = async (source: string, cwd?: string) => {
  const root = await mkdtemp(join(tmpdir(), "snippet-"));
  const agent = new Agent({ root, ...(cwd === undefined ? {} : { cwd }) });
  const realm = agent.realm();
  const result = await agent.run(snippetSource(source, (s) => realm.parses(s)));
  agent.dispose();
  return result.value;
};

describe("a snippet's last expression is its value", () => {
  it("statements, then an expression", async () => {
    expect(await run("const a = 2;\nconst b = 3;\na * b")).toBe(6);
  });
  it("a multi-line trailing expression", async () => {
    expect(
      await run(
        "const xs = [1, 2, 3];\nxs\n  .map((x) => x * 2)\n  .filter((x) => x > 2);",
      ),
    ).toEqual([4, 6]);
  });
  it("top-level await and imports", async () => {
    if (process.platform === "win32") return;
    expect(
      await run(
        'import { join } from "node:path";\nawait Promise.resolve(join("a", "b"))',
      ),
    ).toBe("a/b");
  });
  it("an object literal at the end", async () => {
    expect(await run("const n = 1;\n({ n })")).toEqual({ n: 1 });
  });
  it("a module that exports is left as written", async () => {
    expect(await run("export default 7;")).toBe(7);
  });
  it("ending in a statement has no value", async () => {
    expect(await run("const a = 1;")).toBeUndefined();
  });
  it("keeps line numbers", () => {
    const out = snippetSource("const a = 1;\nconst b = 2;\na + b", () => true);
    expect(out.split("\n")[2]).toContain("a + b");
  });
});

describe("cwd", () => {
  it("$, fs and view resolve relative paths in the session cwd", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "cwd-"));
    const value = await run(
      [
        'import { writeFile, readFile } from "node:fs/promises";',
        'await writeFile("note.txt", "a\\nb");',
        "const pwd = (await $`pwd`).stdout.trim();",
        'const shown = await view("note.txt");',
        '({ pwd, shown, text: await readFile("note.txt") })',
      ].join("\n"),
      dir,
    );
    expect(value).toMatchObject({ shown: "1: a\n2: b", text: "a\nb" });
    expect((value as { pwd: string }).pwd).toMatch(/cwd-/);
  });
});
