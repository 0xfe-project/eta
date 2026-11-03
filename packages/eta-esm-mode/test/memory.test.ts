/**
 * MEMORY.md read/write. Runs under vitest (the package script), `bun test`
 * and `node --test`: the runner is picked at load time and every assertion
 * goes through node:assert, which all three accept.
 */

import type * as NodeTest from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMemoryModule,
  MEMORY_SECTIONS,
  memoryFileLabel,
  parseMemoryFile,
  serializeMemoryFile,
} from "../src/memory.ts";

const { afterEach, beforeEach, describe, it } = (
  process.env.VITEST === undefined
    ? await import("node:test")
    : await import("vitest")
) as Pick<typeof NodeTest, "afterEach" | "beforeEach" | "describe" | "it">;

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-memory-"));
  file = join(dir, "proj", ".eta", "MEMORY.md");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseMemoryFile / serializeMemoryFile", () => {
  it("reads the `- [label#num] text` format into entries", () => {
    const text = [
      "# eta memory (untrusted)",
      "## decision",
      "- [eta~dcdc#0] push to main",
      "- [eta~dcdc#9] task is the subagent",
      "## preference",
      "- [eta~dcdc#1] Use Chinese",
      "## lesson",
      "",
    ].join("\n");
    const entries = parseMemoryFile(text, "/p/MEMORY.md", "eta~dcdc");
    assert.deepEqual(entries, [
      {
        id: "eta~dcdc#0",
        num: 0,
        file: "/p/MEMORY.md",
        section: "decision",
        text: "push to main",
      },
      {
        id: "eta~dcdc#9",
        num: 9,
        file: "/p/MEMORY.md",
        section: "decision",
        text: "task is the subagent",
      },
      {
        id: "eta~dcdc#1",
        num: 1,
        file: "/p/MEMORY.md",
        section: "preference",
        text: "Use Chinese",
      },
    ]);
  });

  it("accepts the harness `- [n]` form and bare hand-written lines", () => {
    const text =
      "## lesson\n- hand written\n- [3] numbered\n- [x] bracket text\n";
    const entries = parseMemoryFile(text, "f", "l");
    assert.deepEqual(
      entries.map((e) => [e.num, e.text]),
      [
        [4, "hand written"],
        [3, "numbered"],
        [5, "[x] bracket text"],
      ],
    );
  });

  it("ignores lines outside the three sections and renumbers duplicates", () => {
    const text =
      "- before any section\n## decision\n- [l#2] a\n- [l#2] copy\n## notes\n- other\n";
    const entries = parseMemoryFile(text, "f", "l");
    assert.deepEqual(
      entries.map((e) => e.id),
      ["l#2", "l#3"],
    );
  });

  it("round-trips, always writing all three sections", () => {
    const entries = parseMemoryFile(
      "## preference\n- [l#0] one\n## decision\n- [l#1] two\n",
      "f",
      "l",
    );
    const out = serializeMemoryFile(entries, "l");
    for (const s of MEMORY_SECTIONS)
      assert.match(out, new RegExp(`^## ${s}$`, "m"));
    assert.deepEqual(parseMemoryFile(out, "f", "l"), [entries[1], entries[0]]);
  });

  it("labels a project file after the directory owning .eta", () => {
    assert.match(
      memoryFileLabel("/w/my proj/.eta/MEMORY.md"),
      /^my_proj~[0-9a-f]{4}$/,
    );
    assert.match(
      memoryFileLabel("/h/.eta/global/MEMORY.md"),
      /^global~[0-9a-f]{4}$/,
    );
  });
});

describe("createMemoryModule", () => {
  it("reads a missing file as empty", async () => {
    const mem = createMemoryModule(file);
    assert.deepEqual(mem.list(), []);
    assert.equal(mem.get("x#0"), undefined);
    assert.equal(await mem.remove("x#0"), false);
  });

  it("add / list / get / remove, persisted to the file", async () => {
    const mem = createMemoryModule(file);
    const a = await mem.add("decision", "first");
    const b = await mem.add("lesson", "second");
    assert.match(a, /^proj~[0-9a-f]{4}#0$/);
    assert.match(b, /#1$/);

    assert.equal(mem.list().length, 2);
    assert.deepEqual(
      mem.list("lesson").map((e) => e.text),
      ["second"],
    );
    assert.equal(mem.get(a)?.section, "decision");

    const disk = await readFile(file, "utf8");
    assert.match(disk, new RegExp(`^- \\[${a}\\] first$`, "m"));

    assert.equal(await mem.remove(a), true);
    assert.equal(await mem.remove(a), false);
    assert.deepEqual(
      createMemoryModule(file)
        .list()
        .map((e) => e.id),
      [b],
    );
  });

  it("sees a hand edit on the next read, and does not overwrite it", async () => {
    const mem = createMemoryModule(file);
    const id = await mem.add("decision", "kept");
    assert.equal(mem.list().length, 1);

    const edited = `${await readFile(file, "utf8")}- added by hand\n`;
    await writeFile(file, edited);
    assert.deepEqual(
      mem.list().map((e) => [e.section, e.text]),
      [
        ["decision", "kept"],
        ["lesson", "added by hand"],
      ],
    );

    await mem.add("preference", "after the edit");
    const texts = createMemoryModule(file)
      .list()
      .map((e) => e.text);
    assert.deepEqual(texts, ["kept", "after the edit", "added by hand"]);
    assert.equal(mem.get(id)?.text, "kept");
  });

  it("serializes concurrent writes and leaves no temp files", async () => {
    const mem = createMemoryModule(file);
    const ids = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mem.add("decision", `n${i}`)),
    );
    assert.equal(new Set(ids).size, 10);
    assert.equal(mem.list().length, 10);
    assert.deepEqual(await readdir(join(dir, "proj", ".eta")), ["MEMORY.md"]);
  });

  it("rejects bad input from realm code, and flattens newlines", async () => {
    const mem = createMemoryModule(file);
    await assert.rejects(
      async () => mem.add("todo" as never, "x"),
      /section must be one of/,
    );
    await assert.rejects(
      async () => mem.add("lesson", "  "),
      /must not be empty/,
    );
    const id = await mem.add("lesson", "one\n## decision\n- two");
    assert.equal(mem.get(id)?.text, "one ## decision - two");
    assert.equal(mem.list().length, 1);
  });
});
