import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The repository root, from this file's directory. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A host that records the environment it was started with, then says it is ready. */
const standInHost = `#!/bin/sh
case "$*" in
  *running*) echo null; exit 0 ;;
esac
# Written beside the name and moved into place: the test polls for that name, so it must never see
# a half-written file.
env > "$HOME/.host-environment"
mv "$HOME/.host-environment" "$HOME/host-environment.txt"
echo '{"port":45999}'
exec sleep 30
`;

const started = (record: string): Map<string, string> =>
  new Map(
    record
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );

async function launch({
  names,
}: {
  names?: Record<string, string>;
} = {}): Promise<{
  home: string;
  environment: () => Promise<Map<string, string> | undefined>;
  account: () => Promise<string>;
  stop: () => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "eta-bootstrap-"));
  const dir = join(home, ".eta", "desktop", "host");
  await mkdir(dir, { recursive: true });
  const host = join(dir, "eta-host");
  await writeFile(host, standInHost);
  await chmod(host, 0o755);
  // Kept, not discarded: when the host never records its environment, these say why.
  const said = join(home, "bootstrap.out");
  const complained = join(home, "bootstrap.err");

  // What launchd hands an app opened from the Dock: only HOME. `names` is the other case — an app
  // that was started with a user environment, complete or with a hole in it.
  const { PATH } = process.env;
  const child = Bun.spawn(
    [process.execPath, join(root, "scripts", "nsh-host-bootstrap.ts"), "0.1.0"],
    {
      cwd: root,
      env: { HOME: home, PATH, ...names },
      stdin: "ignore",
      stdout: Bun.file(said),
      stderr: Bun.file(complained),
    },
  );

  return {
    home,
    environment: async () => {
      const path = join(home, "host-environment.txt");
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const text = await readFile(path, "utf8").catch(() => undefined);
        if (text !== undefined) return started(text);
        await Bun.sleep(50);
      }
      return undefined;
    },
    /** What the launcher said, for the message of a test that timed out waiting on it. */
    account: async () => {
      const out = await readFile(said, "utf8").catch(() => "");
      const err = await readFile(complained, "utf8").catch(() => "");
      return `stdout: ${out.trim() || "(nothing)"}\nstderr: ${err.trim() || "(nothing)"}`;
    },
    stop: async () => {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe("the launcher the packaged app runs", () => {
  it("starts the host with the user names macOS left out", async () => {
    const launcher = await launch();
    try {
      const env = await launcher.environment();
      expect(
        env,
        `the host was never started — ${await launcher.account()}`,
      ).toBeDefined();
      // HOME reaches the host untouched: it is where the host keeps ~/.eta.
      expect(env?.get("HOME")).toBe(launcher.home);
      if (process.platform !== "darwin") {
        expect(env?.get("USER")).toBeUndefined();
        expect(env?.get("LOGNAME")).toBeUndefined();
        return;
      }
      const account = Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString();
      expect(env?.get("USER")).toBe(account.trim());
      expect(env?.get("LOGNAME")).toBe(account.trim());
      expect(
        env?.get("PATH")?.startsWith(join(launcher.home, ".local", "bin")),
      ).toBe(true);
    } finally {
      await launcher.stop();
    }
  }, 60_000);

  it("passes the names the app already has through unchanged", async () => {
    const launcher = await launch({
      names: { USER: "someone-else", LOGNAME: "someone-else" },
    });
    try {
      const env = await launcher.environment();
      expect(
        env,
        `the host was never started — ${await launcher.account()}`,
      ).toBeDefined();
      expect(env?.get("USER")).toBe("someone-else");
      expect(env?.get("LOGNAME")).toBe("someone-else");
      expect(env?.get("HOME")).toBe(launcher.home);
    } finally {
      await launcher.stop();
    }
  }, 60_000);

  it("fills a name that is there but empty, and leaves the other alone", async () => {
    const launcher = await launch({
      names: { USER: "", LOGNAME: "someone-else" },
    });
    try {
      const env = await launcher.environment();
      expect(
        env,
        `the host was never started — ${await launcher.account()}`,
      ).toBeDefined();
      expect(env?.get("LOGNAME")).toBe("someone-else");
      if (process.platform !== "darwin") {
        // Nothing invented where the platform never loses the name.
        expect(env?.get("USER") ?? "").toBe("");
        return;
      }
      const account = Bun.spawnSync(["/usr/bin/id", "-un"]).stdout.toString();
      expect(env?.get("USER")).toBe(account.trim());
    } finally {
      await launcher.stop();
    }
  }, 60_000);
});
