/**
 * Bundles from a git repository, fetched by the primary.
 *
 * A source is `{ repo, rev, path }`. `rev` is a branch, a tag or a commit; it is resolved once to
 * a commit sha, and the sha is what is kept, so fetching again gets the same files until someone
 * asks to update. Only `path` is checked out: the repository's tree under it is extracted, not the
 * history. Credentials are whatever the primary's own `git` is set up with (ssh keys, a credential
 * helper); nothing here stores one, and it never prompts.
 *
 * The files land in `<root>/git/<hash of repo and path>/`, beside a `.sha` marker that says which
 * commit they are, so a directory that is missing or at another commit is fetched again at the
 * recorded sha.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import process from "node:process";

export class FetchError extends Error {
  override readonly name = "FetchError";
}

const SHA = /^[0-9a-f]{40}$/;
const WINDOWS_TAR = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "tar.exe",
);
/** Git for Windows puts GNU tar on PATH in hooks, where a drive path looks like a remote host. */
const TAR =
  process.platform === "win32" && existsSync(WINDOWS_TAR) ? WINDOWS_TAR : "tar";

async function run(
  args: string[],
  cwd: string | undefined,
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
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function must(args: string[], cwd: string | undefined, what: string) {
  const result = await run(args, cwd);
  if (result.code !== 0)
    throw new FetchError(`${what}: ${result.stderr.trim().split("\n").at(-1)}`);
  return result.stdout;
}

/** Where a source's files are kept. */
export function sourceDir(root: string, repo: string, path: string): string {
  const hash = createHash("sha256")
    .update(`${repo}\0${path}`)
    .digest("hex")
    .slice(0, 16);
  return join(root, "git", hash);
}

/** A path inside the repository: relative, and staying in it. `""` is the root. */
export function cleanPath(path: string): string {
  const clean = normalize(path.trim() === "" ? "." : path.trim())
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  if (
    clean.startsWith("/") ||
    /^[A-Z]:\//i.test(clean) ||
    clean === ".." ||
    clean.startsWith("../")
  )
    throw new FetchError(`${path} is not a path inside the repository`);
  return clean === "." ? "" : clean;
}

/** The commit `rev` is at in the repository now. A commit sha is itself. */
export async function resolveRev(
  repo: string,
  rev: string,
): Promise<{ sha: string; ref: string | null }> {
  if (SHA.test(rev)) return { sha: rev, ref: null };
  const name = rev === "" ? "HEAD" : rev;
  const listed = await must(
    [
      "ls-remote",
      repo,
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
  // A tag points at the commit it peels to; a branch is what it is; a bare name wins last.
  for (const ref of [
    `refs/tags/${name}^{}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    name,
  ]) {
    const sha = refs.get(ref);
    if (sha !== undefined) return { sha, ref: ref.replace(/\^\{\}$/, "") };
  }
  throw new FetchError(`${repo} has no branch, tag or commit ${name}`);
}

/**
 * Put the tree of `path` at commit `sha` into `dir`, replacing what is there. The old directory
 * stays until the new one is complete.
 */
export async function fetchInto(options: {
  dir: string;
  repo: string;
  sha: string;
  /** The branch or tag the sha came from, for servers that only give out what they advertise. */
  ref: string | null;
  path: string;
}): Promise<void> {
  const { dir, repo, sha, ref } = options;
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
      ["fetch", "-q", "--depth", "1", repo, sha],
      scratch,
    );
    if (fetched.code !== 0 && ref !== null)
      fetched = await run(["fetch", "-q", "--depth", "1", repo, ref], scratch);
    if (fetched.code !== 0)
      throw new FetchError(
        `cannot fetch ${sha.slice(0, 12)} from ${repo}: ${fetched.stderr.trim().split("\n").at(-1)}`,
      );
    const head = (
      await must(["rev-parse", "FETCH_HEAD"], scratch, "no commit")
    ).trim();
    if (head !== sha)
      throw new FetchError(
        `${repo} moved: ${ref ?? "the revision"} is at ${head.slice(0, 12)}, not ${sha.slice(0, 12)}; refresh to take it`,
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
    const untar = Bun.spawn([TAR, "-xf", archive, "-C", tree], {
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await untar.exited) !== 0)
      throw new FetchError(
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
