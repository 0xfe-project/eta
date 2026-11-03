import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { edit, search, view } from "../src/file-ops.js";

let testDir: string;

beforeEach(async () => {
  // Create a temporary test directory
  testDir = await mkdtemp(join(tmpdir(), "eta-esm-mode-test-"));
});

afterEach(async () => {
  // Clean up the test directory
  await rm(testDir, { recursive: true, force: true });
});

describe("search", () => {
  it("returns structured results with file/line/text", async () => {
    // Create test files
    await writeFile(
      join(testDir, "test1.ts"),
      "export function foo() {}\nexport function bar() {}",
    );
    await writeFile(
      join(testDir, "test2.ts"),
      "const x = 1;\nexport function baz() {}",
    );

    const results = await search("export.*function", { cwd: testDir });

    expect(results.length).toBeGreaterThan(0);

    for (const result of results) {
      expect(result).toHaveProperty("file");
      expect(result).toHaveProperty("line");
      expect(result).toHaveProperty("text");
      expect(result.line).toBeGreaterThan(0);
      expect(result.text).toContain("export");
      expect(result.text).toContain("function");
    }
  });

  it("supports glob filtering", async () => {
    // Create mixed file types
    await writeFile(
      join(testDir, "test.ts"),
      "export function typescript() {}",
    );
    await writeFile(
      join(testDir, "test.js"),
      "export function javascript() {}",
    );
    await writeFile(join(testDir, "test.txt"), "export function text() {}");

    const results = await search("export.*function", {
      cwd: testDir,
      glob: "*.ts",
    });

    expect(results.length).toBeGreaterThan(0);

    for (const result of results) {
      expect(result.file).toMatch(/\.ts$/);
    }
  });

  it("respects limit parameter", async () => {
    // Create a file with many matches
    const lines = Array.from(
      { length: 100 },
      (_, i) => `export function func${i}() {}`,
    ).join("\n");

    await writeFile(join(testDir, "many.ts"), lines);

    const results = await search("export.*function", {
      cwd: testDir,
      limit: 5,
    });

    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("returns empty array when no matches", async () => {
    await writeFile(join(testDir, "empty.ts"), "const x = 1;\nconst y = 2;");

    const results = await search("nonexistent_pattern", { cwd: testDir });

    expect(results).toEqual([]);
  });

  it("includes column and match information", async () => {
    await writeFile(join(testDir, "col.ts"), "  export function test() {}");

    const results = await search("export", { cwd: testDir });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].column).toBeDefined();
    expect(results[0].match).toBe("export");
  });

  it("throws error on invalid pattern", async () => {
    await writeFile(join(testDir, "test.ts"), "test");

    await expect(search("[invalid(regex", { cwd: testDir })).rejects.toThrow();
  });

  it("works with subdirectories", async () => {
    await mkdir(join(testDir, "subdir"));
    await writeFile(
      join(testDir, "subdir/nested.ts"),
      "export function nested() {}",
    );

    const results = await search("export.*function", { cwd: testDir });

    const nestedResult = results.find((r) => r.file.includes("nested.ts"));
    expect(nestedResult).toBeDefined();
  });
});

describe("view", () => {
  it("returns text with line numbers", async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );

    const filePath = join(testDir, "view.txt");
    await writeFile(filePath, content);

    const result = await view(filePath, { start: 3, limit: 5 });

    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("3: line 3");
    expect(lines[4]).toBe("7: line 7");
  });

  it("defaults to start=1 and limit=50", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );

    const filePath = join(testDir, "default.txt");
    await writeFile(filePath, content);

    const result = await view(filePath);

    const lines = result.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("1: line 1");
    expect(lines[49]).toBe("50: line 50");
  });

  it("handles start beyond file length", async () => {
    const filePath = join(testDir, "short.txt");
    await writeFile(filePath, "line 1\nline 2\nline 3");

    const result = await view(filePath, { start: 10 });

    expect(result).toBe("");
  });

  it("handles limit exceeding remaining lines", async () => {
    const filePath = join(testDir, "limit.txt");
    await writeFile(filePath, "line 1\nline 2\nline 3\nline 4\nline 5");

    const result = await view(filePath, { start: 3, limit: 100 });

    const lines = result.split("\n");
    expect(lines).toHaveLength(3); // Only lines 3, 4, 5 remain
    expect(lines[0]).toBe("3: line 3");
    expect(lines[2]).toBe("5: line 5");
  });

  it("throws error for invalid start", async () => {
    const filePath = join(testDir, "invalid.txt");
    await writeFile(filePath, "test");

    await expect(view(filePath, { start: 0 })).rejects.toThrow(
      "start must be >= 1",
    );
  });

  it("throws error for nonexistent file", async () => {
    await expect(view(join(testDir, "nonexistent.txt"))).rejects.toThrow();
  });

  it("preserves empty lines", async () => {
    const filePath = join(testDir, "empty-lines.txt");
    await writeFile(filePath, "line 1\n\nline 3\n\nline 5");

    const result = await view(filePath, { start: 1, limit: 5 });

    const lines = result.split("\n");
    expect(lines[1]).toBe("2: ");
    expect(lines[3]).toBe("4: ");
  });
});

describe("edit", () => {
  it("replaces unique match successfully", async () => {
    const filePath = join(testDir, "edit.ts");
    await writeFile(filePath, "const timeout = 5000;\nconst other = 1;");

    await edit(filePath, "timeout = 5000", "timeout = 10000");

    const { readFile } = await import("node:fs/promises");
    const newContent = await readFile(filePath, "utf-8");

    expect(newContent).toContain("timeout = 10000");
    expect(newContent).not.toContain("timeout = 5000");
  });

  it("throws error on multiple matches", async () => {
    const filePath = join(testDir, "multiple.ts");
    await writeFile(
      filePath,
      "const timeout = 5000;\nconst other = 5000;\nconst another = 5000;",
    );

    await expect(edit(filePath, "5000", "10000")).rejects.toThrow(
      "match is not unique, found 3 occurrences",
    );

    // Verify file unchanged
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content.match(/5000/g)).toHaveLength(3);
  });

  it("throws error when no match found", async () => {
    const filePath = join(testDir, "nomatch.ts");
    await writeFile(filePath, "const x = 1;");

    await expect(edit(filePath, "nonexistent", "replacement")).rejects.toThrow(
      "no match found",
    );

    // Verify file unchanged
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 1;");
  });

  it("handles multiline replacements", async () => {
    const filePath = join(testDir, "multiline.ts");
    const original = "function foo() {\n  return 1;\n}";
    await writeFile(filePath, original);

    const oldText = "function foo() {\n  return 1;\n}";
    const newText = "function foo() {\n  return 2;\n}";

    await edit(filePath, oldText, newText);

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe(newText);
  });

  it("preserves whitespace exactly", async () => {
    const filePath = join(testDir, "whitespace.ts");
    await writeFile(filePath, "const x  =  1;");

    await edit(filePath, "x  =  1", "x = 2");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 2;");
  });

  it("supports sequential edits via loop", async () => {
    const filePath = join(testDir, "sequential.ts");
    await writeFile(filePath, "const a = 1;\nconst b = 2;\nconst c = 3;");

    const edits = [
      ["a = 1", "a = 10"],
      ["b = 2", "b = 20"],
      ["c = 3", "c = 30"],
    ];

    for (const [oldText, newText] of edits) {
      await edit(filePath, oldText, newText);
    }

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const a = 10;\nconst b = 20;\nconst c = 30;");
  });

  it("throws error for nonexistent file", async () => {
    await expect(
      edit(join(testDir, "nonexistent.ts"), "old", "new"),
    ).rejects.toThrow();
  });

  it("handles empty replacement", async () => {
    const filePath = join(testDir, "delete.ts");
    await writeFile(filePath, "const x = /* comment */ 1;");

    await edit(filePath, " /* comment */", "");

    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf-8");
    expect(content).toBe("const x = 1;");
  });
});

describe("mountFileOps", () => {
  it("exposes search/view/edit as realm top-level globals with effects", async () => {
    const { Agent } = await import("../src/index.js");
    const agent = new Agent({ root: testDir });
    await writeFile(
      join(testDir, "probe.ts"),
      "export const greeting = 'hello realm';\n",
    );

    const result = await agent.run(
      [
        `const hits = await search('greeting', { cwd: ${JSON.stringify(testDir)} });`,
        `const text = await view(${JSON.stringify(join(testDir, "probe.ts"))});`,
        `await edit(${JSON.stringify(join(testDir, "probe.ts"))}, 'hello realm', 'hello mounted');`,
        "export default { hits: hits.length, head: text.split('\\n')[0] };",
      ].join("\n"),
      { identifier: join(testDir, "run.js") },
    );

    expect(result.value).toMatchObject({ hits: 1 });
    expect((result.value as { head: string }).head).toContain("1: ");
    expect(result.effects.map((e) => e.name)).toEqual(
      expect.arrayContaining(["search", "view", "edit"]),
    );

    const { readFile } = await import("node:fs/promises");
    const edited = await readFile(join(testDir, "probe.ts"), "utf-8");
    expect(edited).toContain("hello mounted");
  });

  it("blocked edit leaves the file untouched", async () => {
    const { Agent } = await import("../src/index.js");
    const target = join(testDir, "guard.ts");
    await writeFile(target, "const keep = 'original';\n");

    const agent = new Agent({
      root: testDir,
      hooks: {
        authorize: (request) =>
          request.name === "edit" ? "no editing in this test" : undefined,
      },
    });

    await expect(
      agent.run(
        `await edit(${JSON.stringify(target)}, 'original', 'hacked');`,
        {
          identifier: join(testDir, "run2.js"),
        },
      ),
    ).rejects.toThrow("edit was refused");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(target, "utf-8")).toContain("original");
  });
});
