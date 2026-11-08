import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState, saveState } from "../../src/config/state";
import { tempDir } from "../support/temp";

const EMPTY = { tabs: [], activeTab: undefined };

describe("loadState", () => {
  it("gives no tabs for a missing file, broken JSON or the wrong shape", async () => {
    const dir = await tempDir();
    expect(await loadState(join(dir, "missing.json"))).toEqual(EMPTY);
    for (const text of [
      "{",
      "[]",
      "null",
      '"x"',
      '{"tabs": 3}',
      '{"tabs": {}}',
    ]) {
      const file = join(dir, "s.json");
      await writeFile(file, text);
      expect(await loadState(file), text).toEqual(EMPTY);
    }
  });

  it("gives no tabs for a file it cannot read", async () => {
    const file = join(await tempDir(), "s.json");
    await mkdir(file);
    expect(await loadState(file)).toEqual(EMPTY);
  });

  it("counts the active tab among the tabs that were kept", async () => {
    const file = join(await tempDir(), "s.json");
    await writeFile(
      file,
      JSON.stringify({
        tabs: [
          { kind: "chat", id: "a" },
          { kind: "" },
          { kind: "chat", id: "b" },
        ],
        activeTab: 2,
      }),
    );
    // Two tabs survive, so index 2 is past the end.
    expect((await loadState(file)).activeTab).toBeUndefined();
  });

  it("drops an active tab that is out of range or not an integer", async () => {
    const file = join(await tempDir(), "s.json");
    const tabs = [
      { kind: "chat", id: "a" },
      { kind: "chat", id: "b" },
    ];
    for (const activeTab of [2, -1, 0.5, "1", null, true]) {
      await writeFile(file, JSON.stringify({ tabs, activeTab }));
      expect(
        (await loadState(file)).activeTab,
        String(activeTab),
      ).toBeUndefined();
    }
    await writeFile(file, JSON.stringify({ tabs, activeTab: 0 }));
    expect((await loadState(file)).activeTab).toBe(0);
  });
});

describe("saveState", () => {
  it("writes the tabs and the active one, and reads back the same", async () => {
    const file = join(await tempDir(), "deep", "s.json");
    const state = { tabs: [{ kind: "chat", id: "c1" }], activeTab: 0 };
    expect(await saveState(file, state)).toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(state);
    expect(await loadState(file)).toEqual(state);
  });

  it("reports an IO failure instead of throwing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "blocker"), "");
    const file = join(dir, "blocker", "s.json");
    expect(
      await saveState(file, { tabs: [], activeTab: undefined }),
    ).toMatchObject({
      reason: "io",
      file,
    });
  });
});
