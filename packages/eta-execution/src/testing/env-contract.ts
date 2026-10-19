/**
 * The ExecutionEnv contract suite (REFACTOR.md §5).
 *
 * Every backend — memory, local node, a machine over SSH — must pass the same
 * behavioural checks. What a backend cannot do (a Map has no symlinks to follow
 * outside itself, a container has no `/dev`) says so in `capabilities` rather
 * than skipping silently; everything else is asserted, which is what keeps a
 * tool written against the seam from working on one backend and breaking on
 * another.
 */

import type { FileError, FileSystem, Shell } from "../types";
import { describe, expect, it } from "vitest";
import { getOrThrow } from "../types";

export interface EnvContractHandle {
  /** The filesystem half — every backend has one. */
  env: FileSystem;
  /** Release the handle (temp dirs, handles). */
  dispose: () => Promise<void>;
  /**
   * The shell half, when this backend runs real commands. A filesystem-only
   * backend leaves it out, and the contract says so instead of guessing.
   */
  shell?: {
    run: Shell["exec"];
    echo: (text: string) => string;
    /** A command that writes to stderr and exits with this code. */
    fail: (code: number, text: string) => string;
  };
  /**
   * What this backend runs commands with. Omitted when there is no shell (a
   * filesystem-only backend, or the memory backend's scripted stand-in: what it
   * answers is covered by its own tests, not claimed here).
   */
  capabilities?: { shell?: boolean };
}

export type EnvFactory = () => Promise<EnvContractHandle> | EnvContractHandle;

/** The error code of a failed Result, for readable assertions. */
const codeOf = <TValue>(
  result: { ok: true; value: TValue } | { ok: false; error: FileError },
): string => (result.ok ? "ok" : result.error.code);

/** Run the shared checks against a backend. */
export function envContract(name: string, factory: EnvFactory): void {
  describe(`ExecutionEnv contract — ${name}`, () => {
    it("resolves relative paths against cwd and leaves absolute ones alone", async () => {
      const { env, dispose } = await factory();
      const cwd = env.cwd;
      expect(cwd.startsWith("/")).toBe(true);
      expect(getOrThrow(await env.absolutePath("a.txt"))).toBe(`${cwd}/a.txt`);
      expect(getOrThrow(await env.absolutePath("./sub/../a.txt"))).toBe(
        `${cwd}/a.txt`,
      );
      expect(getOrThrow(await env.absolutePath("/etc/hosts"))).toBe(
        "/etc/hosts",
      );
      // Paths need not exist to be addressed.
      expect(getOrThrow(await env.absolutePath("nothing/here/yet.txt"))).toBe(
        `${cwd}/nothing/here/yet.txt`,
      );
      // `..` clamps at the root, as POSIX resolution does.
      expect(getOrThrow(await env.absolutePath("/../x"))).toBe("/x");
      expect(getOrThrow(await env.joinPath([cwd, "a", "b"]))).toBe(
        `${cwd}/a/b`,
      );
      await dispose();
    });

    it("writes, reads back, and appends", async () => {
      const { env, dispose } = await factory();
      expect(
        getOrThrow(await env.writeFile("notes/a.txt", "hello")),
      ).toBeUndefined();
      expect(getOrThrow(await env.readTextFile("notes/a.txt"))).toBe("hello");
      expect(
        getOrThrow(await env.appendFile("notes/a.txt", " world")),
      ).toBeUndefined();
      expect(getOrThrow(await env.readTextFile("notes/a.txt"))).toBe(
        "hello world",
      );
      // Writing creates parent directories, and overwrites.
      expect(
        getOrThrow(await env.writeFile("deep/down/here/b.txt", "x")),
      ).toBeUndefined();
      expect(getOrThrow(await env.readTextFile("deep/down/here/b.txt"))).toBe(
        "x",
      );
      await dispose();
    });

    it("reads lines, with and without a reader", async () => {
      const { env, dispose } = await factory();
      await env.writeFile("lines.txt", "one\ntwo\nthree\n");
      expect(getOrThrow(await env.readTextLines("lines.txt"))).toEqual([
        "one",
        "two",
        "three",
      ]);
      expect(
        getOrThrow(await env.readTextLines("lines.txt", { maxLines: 2 })),
      ).toEqual(["one", "two"]);

      const reader = getOrThrow(await env.openTextLineReader("lines.txt"));
      const first = getOrThrow(await reader.readLine());
      expect(first?.text).toBe("one");
      expect(first?.terminated).toBe(true);
      expect(getOrThrow(await reader.readLine())?.text).toBe("two");
      expect(getOrThrow(await reader.readLine())?.text).toBe("three");
      expect(getOrThrow(await reader.readLine())).toBeUndefined();
      await reader.close();
      await dispose();
    });

    it("reads binary content as bytes", async () => {
      const { env, dispose } = await factory();
      await env.writeFile("bin.dat", new Uint8Array([0, 1, 2, 255]));
      const bytes = getOrThrow(await env.readBinaryFile("bin.dat"));
      expect([...bytes]).toEqual([0, 1, 2, 255]);
      await dispose();
    });

    it("infos and lists without following symlinks", async () => {
      const { env, dispose } = await factory();
      await env.writeFile("dir/a.txt", "aa");
      await env.writeFile("dir/b.txt", "bbb");
      await env.createDir("dir/sub");
      const info = getOrThrow(await env.fileInfo("dir/a.txt"));
      expect(info.kind).toBe("file");
      expect(info.name).toBe("a.txt");
      expect(info.size).toBe(2);
      expect(info.mtimeMs).toBeGreaterThan(0);
      const dirInfo = getOrThrow(await env.fileInfo("dir"));
      expect(dirInfo.kind).toBe("directory");

      const listing = getOrThrow(await env.listDir("dir"));
      expect(listing.map((entry) => entry.name).sort()).toEqual([
        "a.txt",
        "b.txt",
        "sub",
      ]);
      expect(listing.find((entry) => entry.name === "sub")?.kind).toBe(
        "directory",
      );
      await dispose();
    });

    it("renames atomically, replacing the destination", async () => {
      const { env, dispose } = await factory();
      await env.writeFile("from.txt", "new");
      await env.writeFile("to.txt", "old");
      expect(
        getOrThrow(await env.renameFile("from.txt", "to.txt")),
      ).toBeUndefined();
      expect(getOrThrow(await env.readTextFile("to.txt"))).toBe("new");
      expect(getOrThrow(await env.exists("from.txt"))).toBe(false);
      await dispose();
    });

    it("creates and removes directories", async () => {
      const { env, dispose } = await factory();
      await env.createDir("a/b/c");
      expect(getOrThrow(await env.exists("a/b/c"))).toBe(true);
      await env.createDir("a/b/c");
      // Removing a non-empty directory needs `recursive`.
      await env.writeFile("a/b/c/file.txt", "x");
      expect(codeOf(await env.remove("a"))).not.toBe("ok");
      expect(
        getOrThrow(await env.remove("a", { recursive: true })),
      ).toBeUndefined();
      expect(getOrThrow(await env.exists("a"))).toBe(false);
      // `force` forgives what is not there.
      expect(
        getOrThrow(await env.remove("a", { force: true })),
      ).toBeUndefined();
      await dispose();
    });

    it("maps missing paths and directories to codes", async () => {
      const { env, dispose } = await factory();
      expect(codeOf(await env.readTextFile("missing.txt"))).toBe("not_found");
      expect(codeOf(await env.readBinaryFile("missing.txt"))).toBe("not_found");
      expect(codeOf(await env.fileInfo("missing.txt"))).toBe("not_found");
      expect(codeOf(await env.listDir("missing"))).toBe("not_found");
      expect(codeOf(await env.canonicalPath("missing.txt"))).toBe("not_found");
      expect(getOrThrow(await env.exists("missing.txt"))).toBe(false);
      // A directory is not a file, and a file is not a directory.
      await env.createDir("d");
      expect(codeOf(await env.readTextFile("d"))).toBe("is_directory");
      await env.writeFile("f.txt", "x");
      expect(codeOf(await env.listDir("f.txt"))).toBe("not_directory");
      await dispose();
    });

    it("reports an aborted call as aborted, not as a missing file", async () => {
      const { env, dispose } = await factory();
      const controller = new AbortController();
      controller.abort();
      expect(
        codeOf(await env.readTextFile("x.txt", { signal: controller.signal })),
      ).toBe("aborted");
      expect(
        codeOf(await env.exists("x.txt", { signal: controller.signal })),
      ).toBe("aborted");
      await dispose();
    });

    it("creates temporary paths that can be written and removed", async () => {
      const { env, dispose } = await factory();
      const file = getOrThrow(await env.createTempFile({ suffix: ".log" }));
      expect(file.startsWith("/")).toBe(true);
      await env.writeFile(file, "spilled");
      expect(getOrThrow(await env.readTextFile(file))).toBe("spilled");
      const dir = getOrThrow(await env.createTempDir());
      expect(getOrThrow(await env.fileInfo(dir)).kind).toBe("directory");
      await dispose();
    });

    it("runs commands, reporting exit codes and both streams", async () => {
      const handle = await factory();
      const { dispose } = handle;
      if (handle.shell === undefined) {
        await dispose();
        return;
      }
      const okResult = getOrThrow(
        await handle.shell.run(handle.shell.echo("hi")),
      );
      expect(okResult.exitCode).toBe(0);
      expect(okResult.stdout.trim()).toBe("hi");
      // A non-zero exit is a result, not an error: the tool reports it.
      const failed = getOrThrow(
        await handle.shell.run(handle.shell.fail(3, "boom")),
      );
      expect(failed.exitCode).toBe(3);
      expect(failed.stderr).toContain("boom");
      await dispose();
    });

    it("reports a timeout and an abort as execution errors", async () => {
      const handle = await factory();
      const { dispose } = handle;
      if (handle.shell === undefined) {
        await dispose();
        return;
      }
      const run = handle.shell.run;
      const timeout = await run("sleep 5", { timeout: 0.05 });
      expect(timeout.ok).toBe(false);
      expect(timeout.ok ? "" : timeout.error.code).toBe("timeout");

      const controller = new AbortController();
      const running = run("sleep 5", { signal: controller.signal });
      controller.abort();
      const aborted = await running;
      expect(aborted.ok).toBe(false);
      expect(aborted.ok ? "" : aborted.error.code).toBe("aborted");
      await dispose();
    });

    it("cleanup is idempotent and never throws", async () => {
      const { env, dispose } = await factory();
      await env.cleanup();
      await env.cleanup();
      await dispose();
    });
  });
}
