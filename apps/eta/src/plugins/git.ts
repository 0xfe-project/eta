/**
 * Plugins from a git repository, fetched by the primary.
 *
 * A source is `{ repo, rev, path }`. `rev` is resolved once to a commit, and the commit is what is
 * kept: nothing moves until the user asks to update. Only the tree under `path` is taken, not the
 * history. Credentials are whatever the primary's own `git` is set up with, and it never prompts.
 *
 * The files land in `<root>/<hash of repo and path>/`, beside a `.sha` that says which commit they
 * are, so a directory that went missing is fetched again at the recorded commit.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import process from "node:process";
import { PluginError } from "@eta/daemon";

const SHA = /^[0-9a-f]{40}$/;

async function run(
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Never wait for a person: a repository that needs a password is a failure to report.
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
      GCM_INTERACTIVE: "never",
      // A repository is a place to fetch from, not a command: no `ext::`.
      GIT_ALLOW_PROTOCOL: "https:ssh:git:file",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";

async function must(
  args: string[],
  cwd: string | undefined,
  what: string,
): Promise<string> {
  const result = await run(args, cwd);
  if (result.code !== 0)
    throw new PluginError(`${what}: ${lastLine(result.stderr)}`);
  return result.stdout;
}

/** A repository as an argument of `git`: never something it would read as an option. */
function cleanRepo(repo: string): string {
  const clean = repo.trim();
  if (clean === "" || clean.startsWith("-"))
    throw new PluginError(`not a repository: ${repo}`);
  return clean;
}

/** A path inside the repository: relative, and staying in it. `""` is the root. */
export function cleanPath(path: string): string {
  const clean = normalize(path.trim() === "" ? "." : path.trim()).replace(
    /\/+$/,
    "",
  );
  if (clean.startsWith("/") || clean === ".." || clean.startsWith("../"))
    throw new PluginError(`${path} is not a path inside the repository`);
  return clean === "." ? "" : clean;
}

/** Where a source's files are kept. */
export function sourceDir(root: string, repo: string, path: string): string {
  const hash = createHash("sha256")
    .update(`${repo}\0${path}`)
    .digest("hex")
    .slice(0, 16);
  return join(root, hash);
}

/** The commit `rev` is at in the repository now. A commit sha is itself. */
export async function resolveRev(
  repo: string,
  rev: string,
): Promise<{ sha: string; ref: string | null }> {
  if (SHA.test(rev)) return { sha: rev, ref: null };
  const name = rev === "" ? "HEAD" : rev;
  if (name.startsWith("-")) throw new PluginError(`not a revision: ${rev}`);
  const listed = await must(
    [
      "ls-remote",
      "--",
      cleanRepo(repo),
      name,
      `refs/tags/${name}`,
      `refs/tags/${name}^{}`,
      `refs/heads/${name}`,
    ],
    undefined,
    `cannot read ${repo}`,
  );
  const refs = new Map<string, string>();
  for (const line of listed.split("\n")) {
    const [sha, ref] = line.split("\t");
    if (sha !== undefined && ref !== undefined && SHA.test(sha))
      refs.set(ref, sha);
  }
  // A tag is the commit it peels to; a branch is what it is; a bare name wins last.
  for (const ref of [
    `refs/tags/${name}^{}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    name,
  ]) {
    const sha = refs.get(ref);
    if (sha !== undefined) return { sha, ref: ref.replace(/\^\{\}$/, "") };
  }
  throw new PluginError(`${repo} has no branch, tag or commit ${name}`);
}

/** Put the tree of `path` at commit `sha` into `dir`; the old one stays until the new is whole. */
export async function fetchInto(options: {
  dir: string;
  repo: string;
  sha: string;
  ref: string | null;
  path: string;
}): Promise<void> {
  const { dir, sha, ref } = options;
  const repo = cleanRepo(options.repo);
  const path = cleanPath(options.path);
  await mkdir(join(dir, ".."), { recursive: true });
  const work = `${dir}.work-${process.pid}-${Date.now()}`;
  const scratch = join(work, "repo");
  const tree = join(work, "tree");
  try {
    await mkdir(scratch, { recursive: true });
    await mkdir(tree, { recursive: true });
    await must(["init", "-q"], scratch, "cannot prepare a checkout");
    let fetched = await run(
      ["fetch", "-q", "--depth", "1", "--", repo, sha],
      scratch,
    );
    if (fetched.code !== 0 && ref !== null)
      fetched = await run(
        ["fetch", "-q", "--depth", "1", "--", repo, ref],
        scratch,
      );
    if (fetched.code !== 0)
      throw new PluginError(
        `cannot fetch ${sha.slice(0, 12)} from ${repo}: ${lastLine(fetched.stderr)}`,
      );
    const head = (
      await must(["rev-parse", "FETCH_HEAD"], scratch, "no commit")
    ).trim();
    if (head !== sha)
      throw new PluginError(
        `${repo} moved: ${ref ?? "the revision"} is at ${head.slice(0, 12)}, not ${sha.slice(0, 12)}; update to take it`,
      );
    const archive = join(work, "tree.tar");
    await must(
      [
        "archive",
        "--format=tar",
        "-o",
        archive,
        path === "" ? sha : `${sha}:${path}`,
      ],
      scratch,
      `${path === "" ? "the repository" : path} is not in ${repo} at ${sha.slice(0, 12)}`,
    );
    const untar = Bun.spawn(["tar", "-xf", archive, "-C", tree], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await untar.exited) !== 0)
      throw new PluginError(
        `cannot unpack ${repo}: ${(await new Response(untar.stderr).text()).trim()}`,
      );
    await writeFile(`${dir}.sha`, sha);
    const old = `${dir}.old-${process.pid}`;
    if (existsSync(dir)) await rename(dir, old);
    await rename(tree, dir);
    await rm(old, { recursive: true, force: true });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Whether `dir` holds the files of commit `sha`. */
export function isAt(dir: string, sha: string): boolean {
  try {
    return existsSync(dir) && readFileSync(`${dir}.sha`, "utf8").trim() === sha;
  } catch {
    return false;
  }
}
