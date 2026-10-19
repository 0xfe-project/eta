import type { Buffer } from "node:buffer";
/**
 * The daemon as a program: `setup` against a host, the approval, and `run` as a separate process.
 *
 * Child processes are started by their pid and stopped by it; each has a `HOME` of its own, and
 * the daemon's data is `$HOME/.eta/daemon` inside it — the one root, the same rule it runs by on
 * a real machine.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { until } from "./support/client";
import { machineView, makeCode } from "./support/daemon";
import { tempDir } from "./support/host";
import { world } from "./support/world";

const MAIN = fileURLToPath(
  new URL("../../daemon/src/main.ts", import.meta.url),
);

/**
 * Starting a program is not a millisecond job: a `bun` that has to read, transpile and connect
 * takes seconds when the machine is busy with everything else. These waits are for processes, so
 * they are long.
 */
const START_MS = 30_000;

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.pid !== undefined)
      process.kill(child.pid, "SIGTERM");
  }
});

/** Start the daemon's command line as a user whose home is `home`; `output()` is what it printed. */
function daemon(home: string, args: string[]) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home },
  });
  children.push(child);
  let text = "";
  child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  return { child, output: () => text, exited };
}

describe("the daemon's command line", () => {
  it(
    "setup prints the fingerprint the primary shows, waits for approval, and run then serves",
    async () => {
      const w = await world();
      const home = await tempDir("eta-daemon-cli-");
      const dataDir = join(home, ".eta", "daemon");
      const { code, url } = await makeCode(w.client, w.host, "from the cli");

      const setup = daemon(home, ["setup", url, code]);
      await until(
        () =>
          w.client
            .section<{ name: string }[]>("machines", "list")
            ?.some((m) => m.name === "from the cli") === true,
        START_MS,
      );
      const pending = w.client
        .section<{ id: string; fingerprint: string; status: string }[]>(
          "machines",
          "list",
        )!
        .find((machine) => machine.status === "pending")!;
      await until(
        () => setup.output().includes("Waiting for the primary"),
        START_MS,
      );
      // What the terminal says is what the settings page says (in groups, to be read aloud).
      expect(setup.output().replaceAll(/\s/g, "")).toContain(
        pending.fingerprint,
      );
      // The credential is private to the user.
      expect(statSync(join(dataDir, "identity.json")).mode & 0o777).toBe(0o600);

      await w.client.call("machines", "approve", {
        machineId: pending.id,
        fingerprint: pending.fingerprint,
      });
      expect(await setup.exited).toBe(0);
      expect(setup.output()).toContain("Approved.");

      const run = daemon(home, ["run"]);
      await until(
        () => machineView(w.client, pending.id)?.status === "online",
        START_MS,
      );
      expect(run.output()).toContain('"link":"online"');

      // A signal is a shutdown: the daemon stops and the machine goes offline.
      process.kill(run.child.pid!, "SIGTERM");
      expect(await run.exited).toBe(0);
      await until(
        () => machineView(w.client, pending.id)?.status === "offline",
        START_MS,
      );
    },
    2 * START_MS,
  );

  it(
    "setup with a code the primary refuses says so and leaves no identity",
    async () => {
      const w = await world();
      const home = await tempDir("eta-daemon-cli-");
      const dataDir = join(home, ".eta", "daemon");
      const setup = daemon(home, [
        "setup",
        `http://127.0.0.1:${w.host.port}`,
        "eta_nonsense",
      ]);
      expect(await setup.exited).not.toBe(0);
      expect(setup.output()).toMatch(/refused the code \(403/);
      expect(existsSync(join(dataDir, "identity.json"))).toBe(false);
    },
    START_MS,
  );

  it(
    "run without an identity says what to do",
    async () => {
      const home = await tempDir("eta-daemon-cli-");
      const run = daemon(home, ["run"]);
      expect(await run.exited).toBe(2);
      expect(run.output()).toContain("eta-daemon setup");
    },
    START_MS,
  );

  it("refuses to start on the directory an older daemon used, and says how to move it", async () => {
    const home = await tempDir("eta-daemon-cli-");
    mkdirSync(join(home, ".eta-daemon"), { recursive: true });
    const run = daemon(home, ["run"]);
    // Not "no identity": the sessions are still in the old directory, and starting empty would
    // lose them without a word.
    expect(await run.exited).toBe(2);
    expect(run.output()).toContain(
      'mv "$HOME/.eta-daemon" "$HOME/.eta/daemon"',
    );
    expect(run.output()).toContain("uninstall-service");
  });
});
