/**
 * The env contract, run against the local filesystem.
 *
 * The same suite `MemoryEnvironment` runs, which is the point: a tool written
 * against `ExecutionEnv` cannot tell the two apart except by what it asks for.
 * The shell half joins with its own contract in the next slice.
 */
import { chmod, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getOrThrow } from "@eta/execution";
import { envContract } from "@eta/execution/testing";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../src/index";

envContract("node filesystem", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
  const env = new NodeFileSystem({ cwd });
  return {
    env,
    dispose: async () => {
      await env.cleanup();
      await rm(cwd, { recursive: true, force: true });
    },
  };
});

describe("NodeFileSystem specifics", () => {
  it("resolves ~, ~/… and file:// addresses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
    const env = new NodeFileSystem({ cwd });
    expect(getOrThrow(await env.absolutePath("~"))).toBe(homedir());
    expect(getOrThrow(await env.absolutePath("~/notes.txt"))).toBe(
      join(homedir(), "notes.txt"),
    );
    expect(getOrThrow(await env.absolutePath(`file://${cwd}/x.txt`))).toBe(
      join(cwd, "x.txt"),
    );
    // A malformed URL stays an ordinary path: the method never throws.
    expect((await env.absolutePath("file://%")).ok).toBe(true);
    await rm(cwd, { recursive: true, force: true });
  });

  it("follows a symlink only when asked to", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
    const env = new NodeFileSystem({ cwd });
    await env.writeFile("real.txt", "content");
    await symlink("real.txt", join(cwd, "link.txt"));
    // `fileInfo` reports the link itself; `canonicalPath` resolves it.
    expect(getOrThrow(await env.fileInfo("link.txt")).kind).toBe("symlink");
    // `canonicalPath` resolves the platform's own links too (on macOS the temp
    // directory is reached through /private), so compare against realpath.
    expect(getOrThrow(await env.canonicalPath("link.txt"))).toBe(
      await realpath(join(cwd, "real.txt")),
    );
    expect(getOrThrow(await env.readTextFile("link.txt"))).toBe("content");
    await rm(cwd, { recursive: true, force: true });
  });

  it("maps a permission failure to a code, not to not_found", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
    const env = new NodeFileSystem({ cwd });
    await env.writeFile("locked/secret.txt", "x");
    await chmod(join(cwd, "locked"), 0o000);
    const read = await env.readTextFile("locked/secret.txt");
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.error.code).toMatch(/permission_denied|unknown/);
    await chmod(join(cwd, "locked"), 0o700);
    await rm(cwd, { recursive: true, force: true });
  });

  it("reports a torn final line, and keeps bytes across an aborted read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
    const env = new NodeFileSystem({ cwd });
    await env.writeFile("torn.txt", "one\ntwo");
    const reader = getOrThrow(await env.openTextLineReader("torn.txt"));
    expect(getOrThrow(await reader.readLine())?.terminated).toBe(true);
    const last = getOrThrow(await reader.readLine());
    expect(last?.text).toBe("two");
    expect(last?.terminated).toBe(false);
    await reader.close();

    // An abort between reads must not skip the bytes it had already consumed.
    const large = Array.from(
      { length: 200 },
      (_value, index) => `line ${index}`,
    ).join("\n");
    await env.writeFile("many.txt", large);
    const second = getOrThrow(await env.openTextLineReader("many.txt"));
    expect(getOrThrow(await second.readLine())?.text).toBe("line 0");
    const controller = new AbortController();
    controller.abort();
    const stopped = await second.readLine({ signal: controller.signal });
    expect(stopped.ok).toBe(false);
    expect(getOrThrow(await second.readLine())?.text).toBe("line 1");
    await second.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses to write a file where a directory is", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "eta-env-"));
    const env = new NodeFileSystem({ cwd });
    await env.createDir("d");
    const written = await env.writeFile("d", "x");
    expect(written.ok).toBe(false);
    expect(written.ok ? "" : written.error.code).toBe("is_directory");
    await rm(cwd, { recursive: true, force: true });
  });
});
