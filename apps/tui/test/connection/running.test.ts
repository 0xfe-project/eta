/**
 * Asking `eta-host running`: scripts for the answers the real one gives and the ways it can fail,
 * a script that refuses `running` the way a build from before it does, and the real host from
 * source over a temp home that one of its own temporary hosts serves.
 */
import type { HostProgram } from "../../src/connection/types";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  askRunning,
  parseRunning,
  readTokenFile,
} from "../../src/connection/running";
import { launchTemporaryHost } from "../../src/connection/temporary-host";
import { script } from "../support/fake-programs";
import { childEnv, SOURCE_HOST } from "../support/host";
import { tempDir, until } from "../support/temp";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The other processes on this computer whose command line contains `text`. */
async function processesMentioning(text: string): Promise<number[]> {
  // The text goes in through the environment so that the listing's own command line lacks it.
  const env = { ...process.env, ETA_TEST_MENTION: text };
  if (process.platform === "win32") {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:ETA_TEST_MENTION) } | ForEach-Object { $_.ProcessId }",
      ],
      { env },
    );
    return stdout
      .split(/\r?\n/)
      .map(Number)
      .filter((pid) => pid > 0 && pid !== process.pid);
  }
  const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,args="], {
    env,
  });
  return stdout
    .split("\n")
    .filter((line) => line.includes(text))
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => pid > 0 && pid !== process.pid);
}

/**
 * Prints `FAKE_ANSWER` when its arguments are exactly `running`, and something else otherwise,
 * then exits with `FAKE_EXIT`.
 */
function answering(): Promise<HostProgram> {
  return script(`
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(["running"])) {
  if (process.env.FAKE_ANSWER !== undefined) process.stdout.write(process.env.FAKE_ANSWER);
} else console.log("args: " + JSON.stringify(args));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
}

const ask = (
  program: HostProgram,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
) => askRunning({ program, env, timeoutMs });

describe("askRunning", () => {
  it("names the host it prints, with its token file", async () => {
    const program = await answering();
    const answer = await ask(program, {
      FAKE_ANSWER: `${JSON.stringify({
        address: "http://127.0.0.1:54321",
        tokenFile: "/home/me/.eta/access-token",
        from: "service",
      })}\n`,
    });
    expect(answer).toEqual({
      result: "found",
      host: {
        url: "http://127.0.0.1:54321",
        tokenFile: "/home/me/.eta/access-token",
      },
    });
  });

  it("says none for null", async () => {
    const program = await answering();
    expect(await ask(program, { FAKE_ANSWER: "null\n" })).toEqual({
      result: "none",
    });
  });

  it("takes the last line, after anything a build prints first", async () => {
    const program = await answering();
    const answer = await ask(program, {
      FAKE_ANSWER: `warning: something\r\n${JSON.stringify({
        address: "http://[::1]:4000",
        tokenFile: null,
        from: "record",
      })}\r\n\r\n`,
    });
    expect(answer).toEqual({
      result: "found",
      host: { url: "http://[::1]:4000", tokenFile: null },
    });
  });

  it("cannot say when the output is not the expected JSON", async () => {
    const program = await answering();
    for (const output of [
      "",
      "hello",
      '{"address":',
      "[]",
      "42",
      '"null"',
      JSON.stringify({ port: 8787 }),
      JSON.stringify({ address: 8787, tokenFile: null, from: "record" }),
      JSON.stringify({
        address: "mailto:me@box",
        tokenFile: null,
        from: "record",
      }),
      `null\n${JSON.stringify({ port: 1 })}`,
    ]) {
      const answer = await ask(program, { FAKE_ANSWER: output });
      expect(answer.result, output).toBe("unknown");
    }
  });

  it("cannot say when it exits non-zero, even after printing null", async () => {
    const program = await answering();
    const answer = await ask(program, {
      FAKE_ANSWER: "null\n",
      FAKE_EXIT: "1",
    });
    expect(answer.result).toBe("unknown");
  });

  // What every eta-host before `running` does with it: the run's strict flag parsing refuses a
  // positional argument (`apps/eta/src/main.ts`), so it ends without starting a host.
  it("cannot say for a build that takes `running` for an argument of the run", async () => {
    const dir = await tempDir("eta-tui-old-");
    const started = join(dir, "started");
    const program = await script(`
import { parseArgs } from "node:util";
parseArgs({
  args: process.argv.slice(2),
  options: { port: { type: "string", default: "8787" }, version: { type: "boolean" } },
  strict: true,
});
await Bun.write(${JSON.stringify(started)}, "a host started");
`);
    const answer = await ask(program, {});
    expect(answer.result).toBe("unknown");
    expect(answer.result === "unknown" && answer.detail).toMatch(
      /exited with [1-9]/,
    );
    expect(await readFile(started, "utf8").catch(() => "")).toBe("");
  });

  it("cannot say when the program is not there", async () => {
    const dir = await tempDir("eta-tui-gone-");
    const answer = await ask({ command: join(dir, "eta-host"), args: [] }, {});
    expect(answer.result).toBe("unknown");
  });

  it("kills a command that does not answer in time and cannot say", async () => {
    const dir = await tempDir("eta-tui-hang-");
    const pidFile = join(dir, "pid");
    const program = await script(`
await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => undefined, 1_000);
`);
    // Long enough for a loaded machine to start the script and write its pid first.
    const begun = Date.now();
    const answer = await ask(program, {}, 5_000);
    const took = Date.now() - begun;
    expect(answer).toEqual({
      result: "unknown",
      detail: "no answer within 5000 ms",
    });
    expect(took).toBeGreaterThanOrEqual(4_900);
    expect(took).toBeLessThan(8_000);
    const pid = Number(await readFile(pidFile, "utf8"));
    await until(() => !alive(pid), 5_000, "the command to end");
  });

  // On Windows a process Bun started and then started by itself goes when Bun kills its parent, so
  // there the command is cmd.exe, and what its `start /b` leaves behind outlives it.
  it("does not wait on a process the command left behind holding its output", async () => {
    // Not `tempDir`: its directory goes in an `afterEach`, which vitest runs before
    // `onTestFinished`, and with it the pid files that say what to kill.
    const dir = await mkdtemp(join(tmpdir(), "eta-tui-orphan-"));
    const pidFiles = [join(dir, "orphan-1"), join(dir, "orphan-2")];
    const pids = async () =>
      (
        await Promise.all(
          pidFiles.map((file) => readFile(file, "utf8").catch(() => "")),
        )
      )
        .map(Number)
        .filter((pid) => pid > 0);
    // Also when the test times out, which skips the rest of its body.
    onTestFinished(async () => {
      try {
        for (const pid of await pids())
          if (alive(pid)) process.kill(pid, "SIGKILL");
        await until(
          async () => (await processesMentioning(dir)).length === 0,
          10_000,
          `the processes left behind in ${dir} to end`,
        );
      } finally {
        // A process that just ended may still hold a file for a moment on Windows.
        await rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      }
    });
    const orphanScript = join(dir, "orphan.ts");
    await writeFile(
      orphanScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => undefined, 1_000);
`,
    );
    let program: HostProgram;
    if (process.platform === "win32") {
      const batch = join(dir, "eta-host.cmd");
      await writeFile(
        batch,
        [
          "@echo off",
          `start /b "" "${process.execPath}" "${orphanScript}" "${pidFiles[0]}"`,
          `"${process.execPath}" "${orphanScript}" "${pidFiles[1]}"`,
          "",
        ].join("\r\n"),
      );
      program = { command: "cmd.exe", args: ["/d", "/c", batch] };
    } else {
      program = await script(`
for (const file of ${JSON.stringify(pidFiles)})
  Bun.spawn([process.execPath, ${JSON.stringify(orphanScript)}, file], {
    stdio: ["ignore", "inherit", "ignore"],
  });
setInterval(() => undefined, 1_000);
`);
    }
    const begun = Date.now();
    const answer = await ask(program, {}, 5_000);
    expect(answer).toEqual({
      result: "unknown",
      detail: "no answer within 5000 ms",
    });
    expect(Date.now() - begun).toBeLessThan(8_000);
    // What was left behind was there, holding the output, when the call returned.
    const left = await pids();
    expect(left.length).toBeGreaterThan(0);
    expect(left.some(alive)).toBe(true);
  });

  it("names the real host's own temporary host, over the home it serves", async () => {
    const home = await tempDir("eta-tui-running-home-");
    await mkdir(join(home, ".eta"), { recursive: true });
    const env = childEnv(home);
    const launched = await launchTemporaryHost({
      program: SOURCE_HOST,
      env,
      startMs: 60_000,
    });
    if (!launched.ok) throw new Error(launched.output);
    try {
      // The host from source with no flags before the subcommand, as `findHostProgram` gives it.
      const program: HostProgram = {
        command: process.execPath,
        args: [resolve(import.meta.dirname, "../../../eta/src/main.ts")],
      };
      const answer = await ask(program, env, 20_000);
      expect(answer).toEqual({
        result: "found",
        host: { url: launched.host.url, tokenFile: null },
      });
    } finally {
      await launched.host.stop(10_000);
    }
  }, 90_000);
});

describe("parseRunning", () => {
  it("takes an empty token file as none", () => {
    expect(
      parseRunning(
        JSON.stringify({
          address: "127.0.0.1:9",
          tokenFile: "",
          from: "later",
        }),
      ),
    ).toEqual({
      result: "found",
      host: { url: "http://127.0.0.1:9", tokenFile: null },
    });
  });
});

describe("readTokenFile", () => {
  it("is undefined for a file that is missing, empty, or a directory", async () => {
    const dir = await tempDir();
    const empty = join(dir, "empty");
    await writeFile(empty, " \n");
    expect(await readTokenFile(join(dir, "missing"))).toBeUndefined();
    expect(await readTokenFile(empty)).toBeUndefined();
    expect(await readTokenFile(dir)).toBeUndefined();
  });
});
