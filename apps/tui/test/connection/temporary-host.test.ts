/**
 * The temporary host: the real host run from source as a child process, and scripts for the ways
 * a child can fail that the real host does not do on demand.
 */
import type { TemporaryHost } from "../../src/connection/temporary-host";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeUp } from "../../src/connection/probe";
import { launchTemporaryHost } from "../../src/connection/temporary-host";
import { script } from "../support/fake-programs";
import { childEnv, SOURCE_HOST } from "../support/host";
import { tempDir, until } from "../support/temp";

const WIN = process.platform === "win32";
const launched: TemporaryHost[] = [];

afterEach(() => {
  for (const host of launched.splice(0)) host.killNow();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function launch(
  program: Parameters<typeof launchTemporaryHost>[0]["program"],
  options: { startMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const result = await launchTemporaryHost({
    program,
    env: options.env ?? childEnv(await tempDir("eta-tui-home-")),
    startMs: options.startMs ?? 60_000,
  });
  if (result.ok) launched.push(result.host);
  return result;
}

describe("a real temporary host", () => {
  it("stops cleanly when asked the moment it is ready", async () => {
    // The host prints its summary before it listens on the stop pipe: a request sent right
    // away has to be retried until the pipe is there.
    const result = await launch(SOURCE_HOST);
    if (!result.ok) throw new Error(result.output);
    await result.host.stop(10_000);
    expect(alive(result.host.pid)).toBe(false);
    expect(await result.host.exited).toBe(0);
  }, 90_000);

  it("starts on a free port, answers /up, keeps its data under the given home, and stops cleanly", async () => {
    const home = await tempDir("eta-tui-home-");
    const result = await launch(SOURCE_HOST, { env: childEnv(home) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { host } = result;
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.url).not.toBe("http://127.0.0.1:8787");
    expect(await probeUp(host.url, 1_500)).toBe(true);
    expect(existsSync(join(home, ".eta"))).toBe(true);
    // The startup summary is in the output.
    expect(host.output()).toContain(`"port":${new URL(host.url).port}`);

    let exitSeen: number | null | undefined;
    host.onExit((code) => {
      exitSeen = code;
    });
    await host.stop(10_000);
    expect(alive(host.pid)).toBe(false);
    // Exit code 0 is the host's own SIGTERM handler (`process.exit(0)` after closing); a hard
    // kill ends with another code. On Windows the request went over the named pipe.
    expect(await host.exited).toBe(0);
    expect(exitSeen).toBe(0);
    expect(await probeUp(host.url, 500)).toBe(false);
    // Stopping again is harmless and resolves at once.
    await host.stop(10_000);
  }, 90_000);
});

describe("the temporary host's start", () => {
  it("passes --port 0 after the program's own arguments, with no stdin", async () => {
    const program = await script(`
console.log("argv:" + JSON.stringify(process.argv.slice(2)));
const stdin = await new Response(Bun.stdin.stream()).text();
console.log("stdin:" + JSON.stringify(stdin));
console.log(JSON.stringify({ port: 4321 }));
await new Promise((resolve) => setTimeout(resolve, 60_000));
`);
    program.args.push("--first");
    const result = await launch(program);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.host.url).toBe("http://127.0.0.1:4321");
    expect(result.host.output()).toContain('argv:["--first","--port","0"]');
    expect(result.host.output()).toContain('stdin:""');
  });

  it.skipIf(!WIN)(
    "keeps asking on the stop pipe until the host listens on it",
    async () => {
      // Ready first, listening on the stop pipe half a second later: the order the host has
      // (`apps/eta/src/main.ts` prints its summary, then calls `listenForStop`), drawn out.
      const program = await script(`
console.log(JSON.stringify({ port: 4321 }));
await new Promise((resolve) => setTimeout(resolve, 500));
const { createServer } = await import("node:net");
createServer((socket) => socket.on("data", () => process.exit(0))).listen(process.env.ETA_STOP_PIPE);
setInterval(() => undefined, 1_000);
`);
      const result = await launch(program);
      if (!result.ok) throw new Error(result.output);
      const before = Date.now();
      await result.host.stop(5_000);
      expect(await result.host.exited).toBe(0);
      expect(Date.now() - before).toBeLessThan(4_000);
    },
  );

  it("fails, and kills the child, when it never says its port in time", async () => {
    const program = await script(`
console.log("pid:" + process.pid);
await new Promise((resolve) => setTimeout(resolve, 60_000));
`);
    const started = Date.now();
    const result = await launch(program, { startMs: 1_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const pid = Number(/pid:(\d+)/.exec(result.output)![1]);
    await until(() => !alive(pid), 5_000, "the child to be killed");
  });

  it("keeps the last 200 lines of output", async () => {
    const program = await script(`
for (let i = 1; i <= 450; i += 1) console.log("line " + i);
process.exit(1);
`);
    const result = await launch(program);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const lines = result.output.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe("line 251");
    expect(lines.at(-1)).toBe("line 450");
  });
});

describe("the temporary host while it runs", () => {
  it("keeps reading its output so a chatty child does not block", async () => {
    // 4 MiB, far more than a pipe buffer holds: a child nobody reads would stop early on.
    // In 128 lines, fewer than the 200 kept, so both end markers stay in the tail.
    const program = await script(`
console.log(JSON.stringify({ port: 4321 }));
const chunk = "x".repeat(32 * 1024 - 1) + "\\n";
for (let i = 0; i < 128; i += 1) process.stderr.write(chunk);
process.stderr.write("stderr finished\\n");
console.log("finished writing");
// No process.exit: on Linux, Bun drops pipe writes still pending at exit when the reader is slow.
`);
    const result = await launch(program);
    if (!result.ok) throw new Error(result.output);
    expect(await result.host.exited).toBe(0);
    await until(() => result.host.output().includes("finished writing"), 5_000);
    // Both streams are read after the host is ready, to their ends.
    await until(() => result.host.output().includes("stderr finished"), 5_000);
  });

  it("is killed after the stop wait when it ignores the stop request", async () => {
    const program = await script(`
process.on("SIGTERM", () => console.log("ignoring SIGTERM"));
${
  WIN
    ? `
const { createServer } = await import("node:net");
createServer((socket) => socket.on("data", () => console.log("ignoring the pipe"))).listen(process.env.ETA_STOP_PIPE);
`
    : ""
}
console.log(JSON.stringify({ port: 4321 }));
setInterval(() => undefined, 1_000);
`);
    const result = await launch(program);
    if (!result.ok) throw new Error(result.output);
    const started = Date.now();
    await result.host.stop(800);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(700);
    expect(took).toBeLessThan(8_000);
    expect(alive(result.host.pid)).toBe(false);
    expect(await result.host.exited).not.toBe(0);
    expect(result.host.output()).toContain(
      WIN ? "ignoring the pipe" : "ignoring SIGTERM",
    );
  });

  it("dies at once on killNow", async () => {
    const program = await script(`
console.log(JSON.stringify({ port: 4321 }));
setInterval(() => undefined, 1_000);
`);
    const result = await launch(program);
    if (!result.ok) throw new Error(result.output);
    result.host.killNow();
    await result.host.exited;
    expect(alive(result.host.pid)).toBe(false);
  });
});
