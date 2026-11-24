/**
 * A prefix proxy in front of GitHub, and the commit check that no proxy can get past. The "proxy"
 * is a local repository that git is told stands for the proxied address.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchInto, githubProxy, resolveRev } from "../src/plugins/git";
import { tempDir } from "./support/host";

async function git(dir: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const out = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error(await new Response(child.stderr).text());
  return out.trim();
}

const REPO = "https://github.com/o/r.git";
const PREFIX = "https://proxy.test/";
const saved = { ...process.env };
let served: string;
let sha: string;

beforeEach(async () => {
  served = await tempDir("eta-proxy-repo-");
  await git(served, "init", "-q", "-b", "main");
  await git(served, "config", "uploadpack.allowAnySHA1InWant", "true");
  await mkdir(join(served, "p"), { recursive: true });
  await writeFile(join(served, "p", "f.txt"), "what the proxy serves");
  await git(served, "add", ".");
  await git(served, "commit", "-qm", "served");
  sha = await git(served, "rev-parse", "HEAD");
  // Only the proxied address is rewritten to the local repository: the plain one is not served.
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${served}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = `${PREFIX}${REPO}`;
  githubProxy.prefix = PREFIX;
});

afterEach(() => {
  githubProxy.prefix = "";
  for (const key of Object.keys(process.env))
    if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("git through a prefix proxy", () => {
  it("reads the revision and fetches the pinned commit from the proxied address", async () => {
    expect((await resolveRev(REPO, "main")).sha).toBe(sha);
    const root = await tempDir("eta-proxy-out-");
    const dir = join(root, "plugin");
    await fetchInto({ dir, repo: REPO, sha, ref: "main", path: "p" });
    expect(await Bun.file(join(dir, "f.txt")).text()).toBe(
      "what the proxy serves",
    );
    await rm(root, { recursive: true, force: true });
  });

  it("does not take another commit than the pinned one when the proxy serves it", async () => {
    // The pinned commit is not there; the proxy answers the branch with a different one.
    const pinned = "a".repeat(40);
    const root = await tempDir("eta-proxy-out-");
    const dir = join(root, "plugin");
    const error = await fetchInto({
      dir,
      repo: REPO,
      sha: pinned,
      ref: "main",
      path: "p",
    }).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/moved/);
    expect((error as Error).message).toContain(sha.slice(0, 12));
    expect(await Array.fromAsync(new Bun.Glob("*").scan(root))).toEqual([]);
    await rm(root, { recursive: true, force: true });
  });
});
