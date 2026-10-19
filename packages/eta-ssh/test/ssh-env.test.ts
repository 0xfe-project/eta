import type { SshRunOptions, SshTransport } from "../src/transport";
/**
 * The SSH environment against the harness's own ExecutionEnv contract.
 *
 * Run through `LocalTransport`, which speaks the environment's protocol (its `sh`
 * scripts and their exit codes) on this machine. That covers everything the
 * environment itself decides — path resolution, error codes, bounded reads, the
 * shell's three endings — and deliberately *not* the SSH hop: trust, retries and
 * connection reuse are `SshCommandTransport`'s, tested in `transport.test.ts`, and
 * the real target check (when `ETA_SSH_TARGET` is set) covers the join.
 */
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envContract } from "@eta/execution/testing";
import { describe, expect, it } from "vitest";
import { READ_WINDOW_BYTES, SshEnvironment } from "../src/env";
import { LocalTransport } from "../src/local-transport";

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-ssh-home-"));
  roots.push(root);
  return root;
}

envContract("SshEnvironment over LocalTransport", async () => {
  const root = await home();
  const transport = new LocalTransport({ home: root, tempDir: root });
  return {
    env: new SshEnvironment({ transport }),
    shell: {
      run: (command, options) =>
        new SshEnvironment({ transport }).exec(command, options),
      echo: (text: string) =>
        `printf '%s\\n' ${JSON.stringify(text).replace(/"/g, "'")}`,
      fail: (code: number, text: string) =>
        `printf '%s' ${JSON.stringify(text).replace(/"/g, "'")} >&2; exit ${code}`,
    },
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
});

describe("what the ssh environment decides on its own", () => {
  it("resolves ~ to the remote home and keeps the protocol's escape hatches closed", async () => {
    const root = await home();
    const env = new SshEnvironment({
      transport: new LocalTransport({ home: root, tempDir: root }),
    });
    await env.writeFile("a.txt", "hello");
    expect(
      (await env.readTextFile("~/a.txt")).ok &&
        (await env.readTextFile("~/a.txt")),
    ).toBeTruthy();
    // A quoted path is not a shell command: a name with a space or a quote in it
    // is a name, not an injection.
    const name = "odd ' name; echo pwned.txt";
    await env.writeFile(name, "safe");
    const read = await env.readTextFile(name);
    expect(read.ok && read.value).toBe("safe");
    const listing = await env.listDir(".");
    expect(
      listing.ok && listing.value.map((entry) => entry.name).sort(),
    ).toEqual(["a.txt", name].sort());
    await rm(root, { recursive: true, force: true });
  });

  it("streams a long command's output while it runs, and cuts it to the limits", async () => {
    const root = await home();
    const env = new SshEnvironment({
      transport: new LocalTransport({ home: root, tempDir: root }),
    });
    const updates: string[] = [];
    const result = await env.exec(
      'for i in 1 2 3 4 5; do echo "line $i"; done',
      {
        limits: { maxBytes: 2048, maxLines: 3, retain: "tail" },
        onUpdate: (update) => updates.push(update.kind),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);
    // The tail is kept, the totals are the whole truth, and the live view saw it.
    expect(result.value.output).toContain("line 5");
    expect(result.value.output).not.toContain("line 1");
    expect(result.value.truncation?.truncated).toBe(true);
    expect(updates.length).toBeGreaterThan(0);
    await rm(root, { recursive: true, force: true });
  });

  it("interleaves the two streams by arrival order, without a shell merging them", async () => {
    const root = await home();
    const env = new SshEnvironment({
      transport: new LocalTransport({ home: root, tempDir: root }),
    });
    // `output` is the merged view, and it exists when limits were given (without
    // them the caller asked for the whole truth stream by stream).
    const limits = { maxBytes: 4096, maxLines: 50, retain: "tail" as const };
    const spaced = await env.exec(
      "echo one; sleep 0.05; echo err >&2; sleep 0.05; echo two",
      { limits },
    );
    expect(spaced.ok).toBe(true);
    if (!spaced.ok) return;
    // Arrival order, which is the order the machine produced them — the streams
    // were never merged by a shell.
    expect(spaced.value.output).toBe("one\nerr\ntwo\n");
    expect(spaced.value.stdout.trim()).toBe("one\ntwo");
    expect(spaced.value.stderr.trim()).toBe("err");

    // Without a pause the chunks come as the pipe delivers them, so the merged
    // view holds the same lines (order between the two streams is best-effort,
    // exactly as it is for a local command).
    const burst = await env.exec("echo one; echo err >&2; echo two", {
      limits,
    });
    expect(
      burst.ok && burst.value.output?.split("\n").filter(Boolean).sort(),
    ).toEqual(["err", "one", "two"]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("a file bigger than one window", () => {
  /** A local transport that counts the scripts it ran and the most one of them printed. */
  function counting(root: string) {
    const local = new LocalTransport({ home: root, tempDir: root });
    const seen = { scripts: 0, largest: 0 };
    return {
      seen,
      transport: {
        overSsh: local.overSsh,
        home: local.home,
        close: () => local.close(),
        run: async (script: string, options?: SshRunOptions) => {
          const result = await local.run(script, options);
          seen.scripts += 1;
          seen.largest = Math.max(seen.largest, result.stdout.length);
          return result;
        },
      } satisfies SshTransport,
    };
  }

  it("is read in windows, byte for byte, and no script prints more than a window's worth", async () => {
    const root = await home();
    const { seen, transport } = counting(root);
    const env = new SshEnvironment({ transport });
    // Not a multiple of the window, and every byte value in it.
    const size = READ_WINDOW_BYTES * 2 + 12_345;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    expect((await env.writeFile("big.bin", bytes)).ok).toBe(true);
    seen.scripts = 0;

    const read = await env.readBinaryFile("big.bin");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(Buffer.compare(Buffer.from(read.value), Buffer.from(bytes))).toBe(0);
    // The first window says how big the file is; two more bring the rest.
    expect(seen.scripts).toBe(3);
    // Base64 wraps lines, so a window is a bit over four thirds of its bytes.
    expect(seen.largest).toBeLessThan((READ_WINDOW_BYTES * 4 * 1.05) / 3);
  });

  it("reads text that way too, including a character that falls across a window", async () => {
    const root = await home();
    const env = new SshEnvironment({
      transport: new LocalTransport({ home: root, tempDir: root }),
    });
    // Three-byte characters, so some window ends in the middle of one.
    const text = "字".repeat(Math.ceil((READ_WINDOW_BYTES * 2) / 3) + 7);
    await env.writeFile("big.txt", text);
    const read = await env.readTextFile("big.txt");
    expect(read.ok && read.value === text).toBe(true);
    const lines = await env.readTextLines("big.txt");
    expect(lines.ok && lines.value).toEqual([text]);
  });

  it("is still one script for a small file, and an empty file is empty", async () => {
    const root = await home();
    const { seen, transport } = counting(root);
    const env = new SshEnvironment({ transport });
    await env.writeFile("small.txt", "hello\n");
    await env.writeFile("empty.txt", "");
    seen.scripts = 0;
    expect(await env.readTextFile("small.txt")).toEqual({
      ok: true,
      value: "hello\n",
    });
    expect(seen.scripts).toBe(1);
    expect(await env.readTextFile("empty.txt")).toEqual({
      ok: true,
      value: "",
    });
  });
});
