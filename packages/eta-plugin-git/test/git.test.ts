/**
 * Reading a checkout (the `git` plugin's view of a repository).
 *
 * The subject is what the git CLI says about a directory, so the test makes real repositories:
 * `git init`, a commit, and then the things a view has to get right — a clean tree, a staged file,
 * a worktree change, an untracked file, a rename, a non-ASCII path, and a directory that is not a
 * repository at all.
 *
 * Everything here runs the real `git`, because the whole file is "what the CLI says": a fake would
 * test the parser and nothing else.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitDiff,
  gitStatus,
  isSafeRelativePath,
  notGitStatus,
} from "../src/git";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Run git in a directory, and fail the test if it does. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${out}`);
  return out;
}

/** A repository with one committed file. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-git-"));
  roots.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "committed.txt"), "one\ntwo\n", "utf8");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "first");
  return root;
}

describe("reading a checkout", () => {
  it("says what branch it is on and that it is clean", async () => {
    const root = await repository();
    await git(root, "checkout", "-q", "-b", "feature/eta");
    const status = await gitStatus(root);
    expect(status.notGit).toBe(false);
    expect(status.branch).toBe("feature/eta");
    expect(status.groups).toEqual({
      staged: [],
      changes: [],
      untracked: [],
      conflicted: [],
    });
  });

  it("separates staged from modified from untracked, with line counts", async () => {
    const root = await repository();
    await writeFile(join(root, "staged.txt"), "a\nb\n", "utf8");
    await git(root, "add", "staged.txt");
    await writeFile(join(root, "committed.txt"), "one\ntwo\nthree\n", "utf8");
    await writeFile(join(root, "untracked.txt"), "x\ny\n", "utf8");

    const status = await gitStatus(root);
    expect(status.groups.staged.map((file) => file.path)).toEqual([
      "staged.txt",
    ]);
    expect(status.groups.changes.map((file) => file.path)).toEqual([
      "committed.txt",
    ]);
    expect(status.groups.untracked.map((file) => file.path)).toEqual([
      "untracked.txt",
    ]);
    // The counts come from git's own numstat, and the untracked one from a line scan.
    expect(status.groups.changes[0]).toMatchObject({ added: 1, deleted: 0 });
    // `partial` is only present when the scan was cut short: absent means the whole file was read.
    expect(status.groups.untracked[0]).toMatchObject({ added: 2 });
    expect(status.groups.untracked[0]?.partial).toBeUndefined();
  });

  it("reports a rename as one entry carrying where it came from", async () => {
    const root = await repository();
    await git(root, "mv", "committed.txt", "renamed.txt");
    const status = await gitStatus(root);
    expect(status.groups.staged[0]).toMatchObject({
      path: "renamed.txt",
      origPath: "committed.txt",
      status: "R",
    });
  });

  it("answers `notGit` for a directory that is not a checkout", async () => {
    const plain = await mkdtemp(join(tmpdir(), "eta-plain-"));
    roots.push(plain);
    const status = await gitStatus(plain);
    expect(status).toEqual(notGitStatus());
    expect(status.notGit).toBe(true);
  });

  it("gives a unified diff, and synthesises one for an untracked file", async () => {
    const root = await repository();
    await writeFile(join(root, "committed.txt"), "one\nTWO\n", "utf8");
    const worktree = await gitDiff(root, "committed.txt", "worktree");
    expect(worktree?.text).toContain("-two");
    expect(worktree?.text).toContain("+TWO");
    expect(worktree?.truncated).toBe(false);

    await writeFile(join(root, "fresh.txt"), "hello\nworld\n", "utf8");
    const untracked = await gitDiff(root, "fresh.txt", "untracked");
    expect(untracked?.text).toContain("+++ b/fresh.txt");
    expect(untracked?.text).toContain("+hello");
    // A binary file is named as binary rather than shown as mojibake.
    await writeFile(join(root, "blob.bin"), "a\u0000b", "utf8");
    expect((await gitDiff(root, "blob.bin", "untracked"))?.text).toBe(
      "[binary file]",
    );
  });

  it("refuses a path that would leave the checkout", async () => {
    expect(isSafeRelativePath("../secrets")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("a/../b")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("src/index.ts")).toBe(true);
    const root = await repository();
    expect(await gitDiff(root, "../outside", "worktree")).toBeUndefined();
  });

  it("keeps a non-ASCII path as itself", async () => {
    const root = await repository();
    await writeFile(join(root, "héllo.txt"), "hi\n", "utf8");
    const status = await gitStatus(root);
    expect(status.groups.untracked.map((file) => file.path)).toContain(
      "héllo.txt",
    );
  });

  it("does not write to the repository it is reading", async () => {
    const root = await repository();
    await writeFile(join(root, "committed.txt"), "changed\n", "utf8");
    const index = join(root, ".git", "index");
    const before = await Bun.file(index).arrayBuffer();
    await gitStatus(root);
    await mkdir(join(root, "sub"), { recursive: true });
    const after = await Bun.file(index).arrayBuffer();
    // `--no-optional-locks` is what makes this true: git would otherwise refresh the index
    // opportunistically, and a view that writes to the thing it is viewing is not a view.
    expect(new Uint8Array(after)).toEqual(new Uint8Array(before));
  });
});
