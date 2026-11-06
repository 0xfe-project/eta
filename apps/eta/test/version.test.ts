/** The host as a program: `--version` answers without starting anything. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/host";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

describe("eta-host --version", () => {
  it("names the build and leaves the data directory alone", async () => {
    const home = await tempDir("eta-version-");
    const run = spawnSync(process.execPath, [MAIN, "--version"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 30_000,
    });
    expect(run.stdout.trim()).toBe("eta-host dev");
    expect(run.status).toBe(0);
    expect(existsSync(join(home, ".eta"))).toBe(false);
  });
});
