/** The entry point, run as the user runs it: a child process with its own home directories. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const main = resolve(import.meta.dirname, "../src/main.tsx");
const homes: string[] = [];

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "eta-tui-main-"));
  homes.push(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData"),
    LOCALAPPDATA: join(home, "LocalAppData"),
    XDG_CONFIG_HOME: join(home, "xdg"),
    LANG: "C",
    // Bun itself caches transpiled source under ~/.bun when it runs a .tsx file; that is the
    // runtime, not eta, and a compiled eta does not do it.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
  };
  // Pipes, not a terminal: stdin and stdout are not TTYs.
  const result = spawnSync(process.execPath, [main, ...args], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  return { ...result, home };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe("eta entry point", () => {
  it("--version prints eta and the version, and writes nothing", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("eta dev\n");
    expect(result.stderr).toBe("");
    expect(readdirSync(result.home)).toEqual([]);
  });

  it.each([["--help"], ["-h"]])(
    "%s prints the usage with the settings file and the variables, and writes nothing",
    (flag) => {
      const result = run([flag]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/Usage: eta/);
      expect(result.stdout).toContain("--version");
      expect(result.stdout).toContain("ETA_TUI_CONFIG");
      expect(result.stdout).toContain("ETA_TOKEN");
      expect(result.stdout).toContain("ETA_HOST_BIN");
      expect(result.stdout).toMatch(/tui\.json/);
      expect(readdirSync(result.home)).toEqual([]);
    },
  );

  it("refuses an unknown argument with exit code 2, naming it and printing the usage on stderr", () => {
    const result = run(["--frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--frobnicate");
    expect(result.stderr).toMatch(/Usage: eta/);
    expect(readdirSync(result.home)).toEqual([]);
  });

  it("says it needs a terminal and exits 1 when stdin and stdout are not one", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/terminal/i);
    expect(readdirSync(result.home)).toEqual([]);
  });
});
