/**
 * The real-host harness every L4 command test stands on: it returns with the shell connected to
 * an in-process host, runs slash commands, records the programs handed the terminal, and leaves
 * nothing running after the test, also after a test that fails.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { renderWithHost } from "../ext-support/render-with-host";
import { tempDir } from "../support/temp";

describe("renderWithHost guards", () => {
  it("keeps the settings in the temporary directory whatever env the caller passes", async () => {
    // Where a caller's env would point; a directory of the test's own, so a regression writes
    // nowhere that matters.
    const elsewhere = await tempDir("eta-tui-kit-elsewhere-");
    const r = await renderWithHost({
      extensions: [],
      env: {
        ...process.env,
        HOME: elsewhere,
        USERPROFILE: elsewhere,
        APPDATA: elsewhere,
        XDG_CONFIG_HOME: elsewhere,
        ETA_TUI_CONFIG: join(elsewhere, "tui.json"),
        EDITOR: "kept-editor",
      },
    });
    expect(r.paths.config.startsWith(r.home)).toBe(true);
    expect(r.paths.state.startsWith(r.home)).toBe(true);
    expect(r.env.HOME).toBe(r.home);
    expect(r.env.USERPROFILE).toBe(r.home);
    expect(r.env.APPDATA?.startsWith(r.home)).toBe(true);
    expect(r.env.XDG_CONFIG_HOME?.startsWith(r.home)).toBe(true);
    expect(r.env.ETA_TUI_CONFIG?.startsWith(r.home)).toBe(true);
    // What the caller set and the harness does not own still gets through.
    expect(r.env.EDITOR).toBe("kept-editor");
    expect(readdirSync(elsewhere)).toEqual([]);
    await r.close();
  });
});
