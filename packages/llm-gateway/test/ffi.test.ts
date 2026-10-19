/**
 * The conditions the embedding rests on, each in a process of its own (the library loads once per
 * process, and a crash must fail one test, not the runner): streaming under preemption and
 * garbage collection, clients that hang up mid-stream, and the host's signal handlers still
 * running after the library is loaded. The scripts are in `scripts/`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scripts = join(import.meta.dirname, "scripts");

async function run(script: string, ...args: string[]) {
  const child = Bun.spawn(["bun", join(scripts, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr, code };
}

describe("the gateway library inside Bun", () => {
  it("streams under load with the garbage collector running", async () => {
    const { stdout, stderr, code } = await run("stress.ts", "8");
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.split("\n").at(-1)!) as {
      requests: number;
      torn: number;
    };
    expect(result.torn).toBe(0);
    expect(result.requests).toBeGreaterThan(100);
  }, 120_000);

  it("survives clients that hang up mid-stream, and cancels the upstream", async () => {
    const { stdout, stderr, code } = await run("aborts.ts", "50");
    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout.split("\n").at(-1)!) as {
      aborted: number;
      cancelled: number;
      after: number;
    };
    expect(result.aborted).toBeGreaterThan(300);
    expect(result.cancelled).toBeGreaterThanOrEqual(result.aborted);
    expect(result.after).toBe(200);
  }, 120_000);

  it.each(["SIGTERM", "SIGINT"])(
    "still delivers %s to Bun's handler",
    async (signal) => {
      const { stdout, stderr, code } = await run("signal.ts", signal);
      expect(code, stderr).toBe(0);
      expect(stdout).toContain(`bun ${signal} handler ran`);
    },
    60_000,
  );
});
