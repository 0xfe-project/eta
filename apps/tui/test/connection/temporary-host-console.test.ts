/**
 * The terminal's own signals do not reach a temporary host: Ctrl+C (and on POSIX the hangup of a
 * closing terminal) goes to everything in eta's process group or on its console, and the host
 * must stop only when eta asks it to.
 *
 * Each test runs a helper process that stands where eta stands, with a process group (POSIX) or
 * a console (Windows) of its own, so the signal it sends cannot reach the test runner.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { script } from "../support/fake-programs";
import { childEnv, SOURCE_HOST } from "../support/host";
import { tempDir } from "../support/temp";

const WIN = process.platform === "win32";
const TEMPORARY_HOST_MODULE = pathToFileURL(
  resolve(import.meta.dirname, "../../src/connection/temporary-host.ts"),
).href;

/** What the helper prints as its last line. */
interface HelperReport {
  started: boolean;
  output?: string;
  /** "alive", or the exit code the host ended with right after the signal. */
  afterSignal?: "alive" | { exited: number | null };
  answeredUp?: boolean;
  stopCode?: number | null;
}

// The helper: start a temporary host as eta does, send the terminal's signal to its own group or
// console, and see whether the host is still there, still answers, and still stops gracefully.
const HELPER = `
import process from "node:process";
import { launchTemporaryHost } from ${JSON.stringify(TEMPORARY_HOST_MODULE)};

const signal = process.env.HELPER_SIGNAL;
const report = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sendTerminalSignal;
if (process.platform === "win32") {
  const { dlopen, FFIType } = await import("bun:ffi");
  const kernel32 = dlopen("kernel32.dll", {
    GenerateConsoleCtrlEvent: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i32 },
    SetConsoleCtrlHandler: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  // A process started without a console to share gets Ctrl+C turned off, and its children
  // inherit that; a terminal has it on.
  kernel32.symbols.SetConsoleCtrlHandler(null, 0);
  const CTRL_C_EVENT = 0;
  const EVERY_PROCESS_ON_THIS_CONSOLE = 0;
  sendTerminalSignal = () =>
    kernel32.symbols.GenerateConsoleCtrlEvent(CTRL_C_EVENT, EVERY_PROCESS_ON_THIS_CONSOLE);
} else {
  // Started detached, this helper leads its own process group, as eta's shell job would.
  sendTerminalSignal = () => process.kill(-process.pid, signal);
}
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});

const result = await launchTemporaryHost({
  program: JSON.parse(process.env.HELPER_PROGRAM),
  env: process.env,
  startMs: 60_000,
});
if (!result.ok) {
  report({ started: false, output: result.output });
  process.exit(0);
}
const host = result.host;
sendTerminalSignal();
const afterSignal = await Promise.race([
  host.exited.then((code) => ({ exited: code })),
  delay(3_000).then(() => "alive"),
]);
const answeredUp = await fetch(host.url + "/up").then((r) => r.ok, () => false);
await host.stop(10_000);
report({ started: true, afterSignal, answeredUp, stopCode: await host.exited });
process.exit(0);
`;

async function runHelper(signal: "SIGINT" | "SIGHUP"): Promise<HelperReport> {
  const helper = await script(HELPER);
  const env = {
    ...childEnv(await tempDir("eta-tui-home-")),
    HELPER_SIGNAL: signal,
    HELPER_PROGRAM: JSON.stringify(SOURCE_HOST),
  };
  const child = Bun.spawn([helper.command, ...helper.args], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Windows: no inherited stdio and a hidden window give the helper a console of its own.
    // POSIX: a session and process group of its own.
    ...(WIN ? { windowsHide: true } : { detached: true }),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const last = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    return JSON.parse(last) as HelperReport;
  } catch {
    throw new Error(`the helper said no report:\n${stdout}\n${stderr}`);
  }
}

describe("a temporary host and the terminal's signals", () => {
  it.skipIf(!WIN)(
    "keeps running through a Ctrl+C on eta's console, then still answers and stops gracefully over its pipe",
    async () => {
      const report = await runHelper("SIGINT");
      expect(report.started, report.output).toBe(true);
      expect(report.afterSignal).toBe("alive");
      expect(report.answeredUp).toBe(true);
      // 0 is the host's own shutdown after the stop line; a kill ends it with another code.
      expect(report.stopCode).toBe(0);
    },
    90_000,
  );

  // Not run on the Windows machine these were written on.
  it.skipIf(WIN).each(["SIGINT", "SIGHUP"] as const)(
    "keeps running through a %s sent to eta's process group, then still answers and stops gracefully",
    async (signal) => {
      const report = await runHelper(signal);
      expect(report.started, report.output).toBe(true);
      expect(report.afterSignal).toBe("alive");
      expect(report.answeredUp).toBe(true);
      expect(report.stopCode).toBe(0);
    },
    90_000,
  );
});
