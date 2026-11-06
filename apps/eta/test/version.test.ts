/** The host as a program: what answers without starting anything, and what it refuses. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/host";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const host = (args: string[], home: string) =>
  spawnSync(process.execPath, [MAIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    timeout: 30_000,
  });

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

describe("eta-host --help", () => {
  it.each(["--help", "-h"])("%s prints the usage on stdout", async (flag) => {
    const home = await tempDir("eta-help-");
    const run = host([flag], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("eta-host upgrade [version]");
    expect(run.stderr).toBe("");
    expect(existsSync(join(home, ".eta"))).toBe(false);
  });

  it("does not install anything when it follows a subcommand", async () => {
    const home = await tempDir("eta-help-");
    const run = host(["install-service", "--help"], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Usage:");
    expect(existsSync(join(home, ".config"))).toBe(false);
  });

  it("explains upgrade, with where its backups go", async () => {
    const home = await tempDir("eta-help-");
    const run = host(["upgrade", "--help"], home);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("~/.eta/backups");
    expect(run.stdout).toContain("--force");
    expect(run.stdout).toContain("--repo");
    expect(run.stdout).toContain("this build follows: 0xfe-project/eta");
    expect(run.stdout).toContain("ETA_RELEASES_TOKEN");
  });

  it.each(["nothing", "https://me:s3cret@ghe.corp/api/v3/repos/o/r"])(
    "refuses --repo %s before asking anything",
    async (repo) => {
      const home = await tempDir("eta-help-");
      const run = host(["upgrade", "--repo", repo, "--check"], home);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--repo");
      expect(run.stderr).not.toContain("s3cret");
    },
  );
});

describe("what the host does not know", () => {
  it.each([
    [["--nope"], "Unknown option '--nope'"],
    [["nope"], "Unexpected argument 'nope'"],
    [["--port"], "--port"],
    [["upgrade", "--nope"], "Unknown option '--nope'"],
    [["upgrade", "1", "2"], "one version at a time"],
    [["upgrade", "latest"], "not a version: latest"],
    [["upgrade", "--wait", "soon"], "--wait: not a number"],
  ])("%j gets the usage on stderr and exit 2", async (args, error) => {
    const run = host(args, await tempDir("eta-usage-"));
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(error);
    expect(run.stderr).toContain("Usage:");
    expect(run.stderr).not.toContain("ERR_PARSE_ARGS");
    expect(run.stderr).not.toContain("    at ");
  });

  it("does not upgrade a host that runs from source", async () => {
    const run = host(["upgrade"], await tempDir("eta-usage-"));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("runs from source");
  });
});

describe("eta-host --migrations", () => {
  it("lists what the build carries and leaves the data alone", async () => {
    const home = await tempDir("eta-migrations-");
    const run = host(["--migrations"], home);
    expect(run.status).toBe(0);
    expect(run.stdout.split("\n")[0]).toMatch(/^0001-/);
    expect(existsSync(join(home, ".eta"))).toBe(false);
  });
});
