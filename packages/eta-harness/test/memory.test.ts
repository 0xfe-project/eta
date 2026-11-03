/**
 * Memory (ported from eta-agent's `test/eta/memory-persona.test.ts`).
 *
 * The notes are a small untrusted file per project, in three fixed sections, and
 * every rule here exists because of something that goes wrong without it: ids
 * that survive two files merging, an extraction that may only touch its own file,
 * a cap that cuts at a line, and a block that says out loud that its content is
 * untrusted.
 */

import type { MemoryFile, MemoryFs } from "../src/memory";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyExtraction,
  nodeMemoryFs,
  extractionTranscript,
  extractMemory,
  extractMemoryAtRunEnd,
  MEMORY_CAP,
  MEMORY_SECTIONS,
  MemoryCache,
  memoryFileLabel,
  parseMemory,
  renderMemory,
  renderMemoryBlock,
  scanMemory,
  scanMemoryPaths,
} from "../src/memory";

const local: MemoryFile = { path: "/m/MEMORY.md", label: "m" };
/** A target matching the file the extraction tests seed. */
const project: MemoryFile = { path: "/work/.eta/MEMORY.md", label: "m" };
const stored = (
  num: number,
  section: "decision" | "preference" | "lesson",
  text: string,
) => ({
  id: `m#${num}`,
  num,
  file: "/m/MEMORY.md",
  section,
  text,
});

/** A filesystem in a record, so a test can watch mtimes move. */
function memFs(
  files: Record<string, string>,
): MemoryFs & { touch: (path: string) => void; files: Record<string, string> } {
  const times: Record<string, number> = Object.fromEntries(
    Object.keys(files).map((key) => [key, 1_000]),
  );
  return {
    files,
    touch(path) {
      files[path] ??= "";
      times[path] = (times[path] ?? 1_000) + 500;
    },
    async readFile(path) {
      return files[path];
    },
    async mtime(path) {
      if (times[path] !== undefined) return times[path];
      if (files[path] !== undefined) return 1_000;
      // A directory exists when something lives under it (what a git root is).
      return Object.keys(files).some((known) => known.startsWith(`${path}/`))
        ? 1_000
        : undefined;
    },
    async writeFile(path, content) {
      files[path] = content;
      times[path] = (times[path] ?? 1_000) + 1;
    },
    async listFileNames(dir) {
      return Object.keys(files).filter(
        (path) =>
          path.startsWith(`${dir}/`) &&
          !path.slice(dir.length + 1).includes("/"),
      );
    },
  };
}

describe("the memory file", () => {
  it("round-trips the three sections with stable ids", () => {
    const text = renderMemory([
      stored(0, "decision", "must use bun"),
      stored(1, "lesson", "never alias deps blindly"),
    ]);
    expect(parseMemory(text, local)).toEqual([
      stored(0, "decision", "must use bun"),
      stored(1, "lesson", "never alias deps blindly"),
    ]);
  });

  it("numbers a hand-written note, and ignores anything outside a section", () => {
    const entries = parseMemory(
      [
        "# eta memory (untrusted)",
        "a stray line",
        "## decision",
        "- a note with no number",
        "- [7] a numbered note",
        "## not-a-section",
        "- dropped",
        "## lesson",
        "",
      ].join("\n"),
      local,
    );
    expect(entries.map((entry) => entry.id)).toEqual(["m#0", "m#7"]);
    expect(entries[0]?.text).toBe("a note with no number");
    expect(entries[1]?.section).toBe("decision");
  });

  it("renders a block that says it is untrusted, and skips empty sections", () => {
    const block = renderMemoryBlock([stored(0, "decision", "must use bun")]);
    expect(block.startsWith("<memory>")).toBe(true);
    expect(block).toContain("[untrusted notes collected earlier]");
    expect(block).toContain("## decision\n- [m#0] must use bun");
    expect(block).not.toContain("## preference");
    expect(renderMemoryBlock([])).toBe(
      `<memory>\n[untrusted notes collected earlier]\n\n</memory>`,
    );
  });

  it("labels a file by the directory that owns it", () => {
    expect(
      memoryFileLabel("/work/eta-agent/.eta/MEMORY.md", "/home/lemon"),
    ).toBe(
      `eta-agent~${memoryFileLabel("/work/eta-agent/.eta/MEMORY.md", "/home/lemon").split("~")[1]}`,
    );
    expect(memoryFileLabel("/home/lemon/.eta/MEMORY.md", "/home/lemon")).toBe(
      "user",
    );
    // Two directories with the same name stay apart.
    expect(memoryFileLabel("/a/eta/.eta/MEMORY.md", "/home/lemon")).not.toBe(
      memoryFileLabel("/b/eta/.eta/MEMORY.md", "/home/lemon"),
    );
  });
});

describe("finding the project's notes", () => {
  it("walks up to the git root, outermost file first, and targets the nearest", async () => {
    const fs = memFs({
      "/repo/.git/HEAD": "ref: refs/heads/main",
      "/repo/.eta/MEMORY.md":
        "# eta memory (untrusted)\n## decision\n- [0] from the repo\n",
      "/repo/pkg/.eta/MEMORY.md":
        "# eta memory (untrusted)\n## decision\n- [0] from the package\n",
    });
    const scan = await scanMemory(fs, "/repo/pkg/src", "/home/lemon");
    expect(scan.projectRoot).toBe("/repo");
    expect(scan.files.map((file) => file.path)).toEqual([
      "/repo/.eta/MEMORY.md",
      "/repo/pkg/.eta/MEMORY.md",
    ]);
    // Notes go to the nearest file that exists, not the outermost one.
    expect(scan.target.path).toBe("/repo/pkg/.eta/MEMORY.md");
    expect(
      await scanMemoryPaths(fs, "/repo/pkg/src", "/home/lemon"),
    ).toHaveLength(2);
  });

  it("treats the opened folder as the project outside a checkout", async () => {
    const fs = memFs({});
    const scan = await scanMemory(fs, "/work/scratch", "/home/lemon");
    expect(scan.projectRoot).toBe("/work/scratch");
    expect(scan.files).toEqual([]);
    expect(scan.target.path).toBe("/work/scratch/.eta/MEMORY.md");
  });
});

describe("the memory cache", () => {
  it("re-reads only when a file changed, and merges two files' notes", async () => {
    const fs = memFs({
      "/repo/.git/HEAD": "x",
      "/repo/.eta/MEMORY.md":
        "# eta memory (untrusted)\n## decision\n- [0] outermost\n",
      "/repo/pkg/.eta/MEMORY.md":
        "# eta memory (untrusted)\n## preference\n- [0] nearest\n",
    });
    const cache = new MemoryCache(fs, "/home/lemon");
    const first = await cache.load("/repo/pkg");
    expect(first.text).toContain("outermost");
    expect(first.text).toContain("nearest");
    expect(first.files).toHaveLength(2);

    // Nothing changed: the same answer, from the cache.
    expect(await cache.load("/repo/pkg")).toBe(first);

    fs.files["/repo/pkg/.eta/MEMORY.md"] =
      "# eta memory (untrusted)\n## preference\n- [0] edited\n";
    fs.touch("/repo/pkg/.eta/MEMORY.md");
    const second = await cache.load("/repo/pkg");
    expect(second).not.toBe(first);
    expect(second.text).toContain("edited");
  });

  it("cuts an over-long block at a line, and says so", async () => {
    const long = Array.from(
      { length: 400 },
      (_value, index) => `- [${index}] ${"x".repeat(80)}`,
    ).join("\n");
    const fs = memFs({
      "/work/.eta/MEMORY.md": `# eta memory (untrusted)\n## decision\n${long}\n`,
    });
    const loaded = await new MemoryCache(fs, "/home/lemon").load("/work");
    expect(loaded.text.length).toBeLessThanOrEqual(
      MEMORY_CAP + "[memory truncated at cap]".length + 2,
    );
    expect(loaded.text).toContain("[memory truncated at cap]");
    expect(loaded.text.endsWith("[memory truncated at cap]")).toBe(true);
  });
});

describe("extraction", () => {
  it("appends without duplicating, removes by id, and reports foreign ids", async () => {
    const fs = memFs({
      "/work/.eta/MEMORY.md": renderMemory([
        stored(0, "decision", "already known"),
      ]),
    });
    const result = await applyExtraction(fs, project, {
      add_new_decision: ["already known", "a new decision"],
      learn_new_lesson: ["a lesson"],
      remove_memory_ids: ["m#0", "other~1a2b#3"],
    });
    // The duplicate was not added; the foreign id was counted, not applied.
    expect(result).toEqual({ added: 2, removed: 1, foreign: 1 });
    const entries = parseMemory(fs.files[project.path]!, project);
    expect(entries.map((entry) => entry.text)).toEqual([
      "a new decision",
      "a lesson",
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(["m#1", "m#2"]);
  });

  it("asks the model with the current notes in view, and applies what it answers", async () => {
    const fs = memFs({
      "/work/.eta/MEMORY.md": renderMemory([stored(0, "decision", "old note")]),
    });
    let seenSystem = "";
    let seenPrompt = "";
    const result = await extractMemory(
      fs,
      project,
      "user: we decided to port the harness",
      async (system, prompt) => {
        seenSystem = system;
        seenPrompt = prompt;
        return 'sure!\n{"add_new_decision":["port the harness"],"remove_memory_ids":["m#0"]}';
      },
    );
    expect(result).toEqual({ added: 1, removed: 1, foreign: 0 });
    expect(seenSystem).toContain("notes on what's worth remembering");
    // The notes ride along, or the model could only guess at what is obsolete.
    expect(seenPrompt).toContain("[m#0] old note");
    expect(seenPrompt).toContain("we decided to port the harness");
    expect(
      parseMemory(fs.files[project.path]!, project).map((entry) => entry.text),
    ).toEqual(["port the harness"]);
  });

  it("gives up quietly on a reply with no JSON in it", async () => {
    const fs = memFs({ "/work/.eta/MEMORY.md": "" });
    expect(
      await extractMemory(
        fs,
        project,
        "user: hi",
        async () => "I have no idea",
      ),
    ).toBeUndefined();
  });

  it("is asked at the end of a run, and never fails the run", async () => {
    const fs = memFs({ "/work/.eta/MEMORY.md": "" });
    const outcomes: unknown[] = [];
    const source = {
      fs,
      target: local,
      // The default gate is 200 characters; this test is about the call, not
      // about how much conversation is worth one.
      minTranscriptChars: 1,
      call: async () => '{"add_new_decision":["a durable thing"]}',
    };
    const messages = [
      {
        role: "user",
        content:
          "We must always use bun for this project, never npm, and the journal stays append-only — please remember both of those.",
      },
    ];
    expect(
      await extractMemoryAtRunEnd(source, messages, (outcome) =>
        outcomes.push(outcome),
      ),
    ).toEqual({
      added: 1,
      removed: 0,
      foreign: 0,
    });

    // A thin conversation is not worth a call, and a broken provider is not a
    // reason for a run to look failed.
    expect(
      await extractMemoryAtRunEnd(
        { fs, target: local, call: async () => "{}" },
        [{ role: "user", content: "hi" }],
      ),
    ).toEqual({ added: 0, removed: 0, foreign: 0, skipped: "thin" });
    expect(
      await extractMemoryAtRunEnd(
        {
          fs,
          target: local,
          minTranscriptChars: 1,
          call: async () => {
            throw new Error("provider down");
          },
        },
        messages,
      ),
    ).toMatchObject({ skipped: "provider", reason: "provider down" });
  });

  it("keeps notes about the person, not about the ls output", () => {
    const text = extractionTranscript([
      { role: "user", content: "please remember the codename" },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: {} }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "a hundred lines of ls" }],
      },
    ]);
    expect(text).toContain("user: please remember the codename");
    expect(text).toContain("assistant: noted");
    expect(text).toContain("[ran bash]");
    expect(text).not.toContain("a hundred lines");
  });
});

describe("the local-disk filesystem", () => {
  it("reads, writes and reports mtimes through node:fs", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-memory-"));
    try {
      const fs = nodeMemoryFs();
      const file = join(root, ".eta", "MEMORY.md");
      expect(await fs.readFile(file)).toBeUndefined();
      expect(await fs.mtime(file)).toBeUndefined();
      expect(await fs.listFileNames(join(root, ".eta"))).toEqual([]);
      await fs.writeFile(
        file,
        "# eta memory (untrusted)\n## decision\n- [0] a note\n",
      );
      expect(await fs.readFile(file)).toContain("a note");
      expect(await fs.mtime(file)).toBeGreaterThan(0);
      expect(await fs.listFileNames(join(root, ".eta"))).toEqual(["MEMORY.md"]);
      // The three sections are the contract both sides write.
      expect(MEMORY_SECTIONS).toEqual(["decision", "preference", "lesson"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
