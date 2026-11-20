/**
 * The memory file format on its own: the three sections, the bullets, and the ids that follow from
 * them. The service and the disk are not involved.
 */
import type { FileEntry } from "../src/captain/memory-file";
import { describe, expect, it } from "vitest";
import { parseMemoryFile, renderMemoryFile } from "../src/captain/memory-file";

const PATH = "agents/ada/.eta/MEMORY.md";

const sample = `# eta memory (untrusted)
## decision
- ship on Friday
## notes
- this section is unknown
## preference
- tea, no sugar
## lesson
- ask before deleting
`;

describe("parseMemoryFile", () => {
  it("keeps decision, preference, and lesson, and drops an unknown section", () => {
    const entries = parseMemoryFile(PATH, sample);
    expect(
      entries.map((entry) => ({ section: entry.section, text: entry.text })),
    ).toEqual([
      { section: "decision", text: "ship on Friday" },
      { section: "preference", text: "tea, no sugar" },
      { section: "lesson", text: "ask before deleting" },
    ]);
  });
});

describe("renderMemoryFile", () => {
  it("round-trips text and section, with the same id for the same text", () => {
    const entries: FileEntry[] = [
      { id: "unused", text: "ship on Friday", section: "decision", path: PATH },
      {
        id: "unused",
        text: "tea, no sugar",
        section: "preference",
        path: PATH,
      },
    ];
    const again = parseMemoryFile(PATH, renderMemoryFile(entries));
    expect(
      again.map((entry) => ({ section: entry.section, text: entry.text })),
    ).toEqual(
      entries.map((entry) => ({ section: entry.section, text: entry.text })),
    );
    expect(again[0]!.id).toBe(
      parseMemoryFile(PATH, renderMemoryFile(entries))[0]!.id,
    );
  });
});
