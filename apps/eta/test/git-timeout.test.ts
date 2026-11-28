import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchInto, resolveRev } from "../src/plugins/git";

/** A git:// server that takes the connection and never answers. */
let server: Bun.TCPSocketListener<undefined>;
let opened = 0;
let closed = 0;
let repo = "";
// Long enough that a loaded machine still gets `git` to connect before the limit; the test is about the kill, not the speed.
const LIMIT_MS = 3000;

beforeEach(() => {
  opened = 0;
  closed = 0;
  server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: () => void opened++,
      close: () => void closed++,
      data: () => {},
    },
  });
  repo = `git://127.0.0.1:${server.port}/r.git`;
});

afterEach(() => {
  server.stop(true);
});

async function ended(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (opened > 0 && closed >= opened) break;
    await Bun.sleep(100);
  }
  return opened > 0 && closed === opened;
}

describe("a git call that does not answer", () => {
  it("fails ls-remote with the step, the repository and a hint, and the process ends", async () => {
    const started = Date.now();
    const error = await resolveRev(repo, "main", LIMIT_MS).catch(
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("git ls-remote");
    expect(message).toContain(repo);
    expect(message).toMatch(/slow, or the repository needs credentials/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await ended()).toBe(true);
  });

  it("fails fetch the same way, and leaves no checkout behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "eta-git-"));
    try {
      const dir = join(root, "p");
      const error = await fetchInto({
        dir,
        repo,
        sha: "a".repeat(40),
        ref: null,
        path: "",
        limitMs: LIMIT_MS,
      }).catch((e: Error) => e);
      expect((error as Error).message).toContain("git fetch");
      expect((error as Error).message).toContain(repo);
      expect(await ended()).toBe(true);
      expect(await Array.fromAsync(new Bun.Glob("*").scan(root))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
