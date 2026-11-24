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
const WINDOWS_TAR = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "tar.exe",
);
/** Git for Windows puts GNU tar on PATH in hooks, where a drive path looks like a remote host. */
const TAR =
  process.platform === "win32" && existsSync(WINDOWS_TAR) ? WINDOWS_TAR : "tar";

/**
 * The prefix of a GitHub proxy (`https://proxy.example/`, in front of the whole original URL), or `""`
 * for none. The market sets it from the settings; every `git` call reads it. Only github.com and
 * raw.githubusercontent.com are ever sent through it.
 */
export const githubProxy = { prefix: "" };
const GITHUB_HOSTS = ["github.com", "raw.githubusercontent.com"];

/** A prefix as it is kept: http(s), one trailing slash; `""` is none. */
export function normalizeProxy(value: string): string {
  const clean = value.trim();
  if (clean === "") return "";
  let url: URL;
  try {
    url = new URL(clean);
  } catch {
    throw new PluginError(`the proxy is not a URL: ${clean}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new PluginError("the proxy is not an http(s) URL");
  return `${clean.replace(/\/+$/, "")}/`;
}

/** `url` as it is fetched: behind the proxy when it is a GitHub address, else itself. */
export function viaProxy(url: string, prefix = githubProxy.prefix): string {
  // The same normalization as when it is saved, so the stored value and the built URL agree.
  let base: string;
  try {
    base = normalizeProxy(prefix);
  } catch {
    return url;
  }
  if (base === "" || url.startsWith(base)) return url;
  try {
    const address = new URL(url);
    const web = address.protocol === "https:" || address.protocol === "http:";
    return web && GITHUB_HOSTS.includes(address.hostname.toLowerCase())
      ? base + url
      : url;
  } catch {
    return url;
  }
}

/** What an error says when the address was reached through the proxy: the repository is always the original. */
const through = (repo: string): string =>
  viaProxy(repo) === repo ? "" : " (through the GitHub proxy)";

/** How long one `git` call may take before it is killed and reported. `ms` is changed by tests only. */
export const GIT_TIMEOUT_MS = 20_000;
export const gitLimit = { ms: GIT_TIMEOUT_MS };

/** Stop `child` and what it started: on Windows `git` leaves `git-remote-https` behind otherwise. */
function stop(child: Bun.Subprocess): void {
  if (process.platform === "win32")
    Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(child.pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  child.kill();
}

async function run(
  args: string[],
  cwd?: string,
  repo?: string,
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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop(child);
  }, gitLimit.ms);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut)
      throw new PluginError(
        `git ${args[0]}${repo === undefined ? "" : ` for ${repo}${through(repo)}`} gave no answer in ${gitLimit.ms / 1000} s: the network is slow, or the repository needs credentials`,
      );
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";

async function must(
  args: string[],
  cwd: string | undefined,
  what: string,
  repo?: string,
): Promise<string> {
  const result = await run(args, cwd, repo);
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
  const clean = normalize(path.trim() === "" ? "." : path.trim())
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  if (
    clean.startsWith("/") ||
    /^[A-Z]:\//i.test(clean) ||
    clean === ".." ||
    clean.startsWith("../")
  )
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
      viaProxy(cleanRepo(repo)),
      name,
      `refs/tags/${name}`,
      `refs/tags/${name}^{}`,
      `refs/heads/${name}`,
    ],
    undefined,
    `cannot read ${repo}${through(repo)}`,
    repo,
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
  const remote = viaProxy(repo);
  await mkdir(join(dir, ".."), { recursive: true });
  const work = `${dir}.work-${process.pid}-${Date.now()}`;
  const scratch = join(work, "repo");
  const tree = join(work, "tree");
  try {
    await mkdir(scratch, { recursive: true });
    await mkdir(tree, { recursive: true });
    await must(["init", "-q"], scratch, "cannot prepare a checkout");
    let fetched = await run(
      ["fetch", "-q", "--depth", "1", "--", remote, sha],
      scratch,
      repo,
    );
    if (fetched.code !== 0 && ref !== null)
      fetched = await run(
        ["fetch", "-q", "--depth", "1", "--", remote, ref],
        scratch,
        repo,
      );
    if (fetched.code !== 0)
      throw new PluginError(
        `cannot fetch ${sha.slice(0, 12)} from ${repo}${through(repo)}: ${lastLine(fetched.stderr)}`,
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
      repo,
    );
    const untar = Bun.spawn([TAR, "-xf", archive, "-C", tree], {
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
