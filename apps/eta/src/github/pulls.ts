/**
 * Pull requests a task delivered, for the task's detail: their state and size, and merging one
 * when the user asks to.
 *
 * Both act as the user who authorized the App, so GitHub applies the user's own permissions, and
 * as the App without an authorization. Merging never asks GitHub to bypass anything: no admin
 * override, no auto-merge, no branch deletion; it names the head commit the user saw, so a pull
 * request updated since is not merged.
 */
import type { GitHubPull } from "@eta/client-contracts";
import type { Github } from "./service";
import { fromGitHub, reasons, segment, statusOf } from "./api";
import { GithubError } from "./error";

/** GitHub's JSON for a pull request, as far as it is read. */
interface RawPull {
  html_url: string;
  title: string;
  state: string;
  draft?: boolean;
  merged?: boolean;
  additions?: number;
  deletions?: number;
  head?: { sha?: string };
  mergeable?: boolean | null;
  mergeable_state?: string;
}

interface RawRepo {
  allow_squash_merge?: boolean;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  permissions?: {
    push?: boolean;
    maintain?: boolean;
    admin?: boolean;
  };
}

/** `[owner, name, number]` from a pull request's URL on github.com. */
function parsePullUrl(value: string): [string, string, number] {
  const invalid = () =>
    new GithubError(
      "INVALID_PULL_REQUEST",
      400,
      `${value} is not a GitHub PR link.`,
    );
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid();
  }
  if (url.hostname !== "github.com") throw invalid();
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const [owner, name, kind, raw] = parts;
  if (parts.length < 4 || kind !== "pull") throw invalid();
  const number = /^\d+$/.test(raw ?? "") ? Number(raw) : 0;
  if (number <= 0 || !owner || !name) throw invalid();
  return [owner, name, number];
}

/** Who reads and merges: the token, and whether it is the user's. */
interface Reader {
  token: string;
  asUser: boolean;
}

/**
 * Who reads and merges: the user who authorized the App, or the App. A token GitHub refuses (401)
 * is forgotten and the App is used.
 */
async function reader(
  github: Github,
  owner: string,
  retry: boolean,
): Promise<Reader> {
  if (!retry) {
    const user = await github.userToken();
    if (user !== null) return { token: user.accessToken, asUser: true };
  }
  const installation = await github.installationFor(owner);
  const token = await github.installationToken(installation.id);
  return { token: token.value, asUser: false };
}

/** A pull request and its repository as read by `reader`, for what comes next. */
interface Read {
  reader: Reader;
  pull: RawPull;
  repo: RawRepo;
}

async function fetchPull(
  github: Github,
  token: string,
  owner: string,
  name: string,
  number: number,
): Promise<{ pull: RawPull; repo: RawRepo }> {
  const path = `/repos/${segment(owner)}/${segment(name)}`;
  const pull = await github.http.api<RawPull>({
    path: `${path}/pulls/${number}`,
    token,
  });
  const repo = await github.http.api<RawRepo>({ path, token });
  return { pull, repo };
}

const readError = (error: unknown): GithubError => {
  if (statusOf(error) === 404 || statusOf(error) === 403)
    return new GithubError(
      "PULL_REQUEST_UNREACHABLE",
      424,
      "This PR is not visible on GitHub: the App or your account lacks permission for this repository, or the PR no longer exists.",
    );
  return fromGitHub(error);
};

/** Reads the pull request and its repository; after GitHub refused the user's token, as the App. */
async function readAs(
  github: Github,
  owner: string,
  name: string,
  number: number,
): Promise<Read> {
  github.require();
  let who = await reader(github, owner, false);
  let found: { pull: RawPull; repo: RawRepo };
  try {
    found = await fetchPull(github, who.token, owner, name, number);
  } catch (error) {
    if (who.asUser && statusOf(error) === 401) {
      await github.dropUser();
      who = await reader(github, owner, true);
      try {
        found = await fetchPull(github, who.token, owner, name, number);
      } catch (again) {
        throw readError(again);
      }
    } else {
      throw readError(error);
    }
  }
  return { reader: who, ...found };
}

/** The pull request as the task's detail shows it, judged with what `read` found. */
function view(read: Read, pull: RawPull): GitHubPull {
  const p: GitHubPull = {
    url: pull.html_url,
    title: pull.title,
    state: pull.state === "open" ? "open" : "closed",
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    headSha: pull.head?.sha ?? "",
  };
  if (pull.merged === true) {
    p.state = "merged";
    return p;
  }
  if (pull.state !== "open") {
    p.state = "closed";
    return p;
  }
  if (pull.draft === true) {
    p.state = "draft";
    p.merge = "blocked";
    p.reason =
      "Draft PRs cannot be merged, mark it as ready for review on GitHub first.";
    return p;
  }
  const [merge, reason] = mergeability(pull, read.repo, read.reader.asUser);
  p.merge = merge;
  if (reason !== "") p.reason = reason;
  return p;
}

/**
 * Whether GitHub would merge `pull` now, as far as its mergeable_state tells; GitHub computes it
 * in the background, so it may not be known yet. The repository's permissions are the user's: read
 * with the App's installation token they are all false, whatever the App was granted, so only the
 * user's are looked at; for the App, GitHub decides when merging.
 */
function mergeability(
  pull: RawPull,
  repo: RawRepo,
  asUser: boolean,
): ["ready" | "pending" | "blocked", string] {
  const perms = repo.permissions;
  if (
    asUser &&
    perms !== undefined &&
    perms.push !== undefined &&
    !perms.push &&
    !perms.maintain &&
    !perms.admin
  )
    return [
      "blocked",
      "Your GitHub account does not have write permission for this repository, so it cannot be merged.",
    ];
  if (mergeMethod(repo) === "" && repo.allow_merge_commit !== undefined)
    return ["blocked", "The repository does not allow any merge method."];
  const state = pull.mergeable_state ?? "";
  if (
    pull.mergeable === undefined ||
    pull.mergeable === null ||
    state === "unknown" ||
    state === ""
  )
    return [
      "pending",
      "GitHub is still computing mergeability, refresh later.",
    ];
  if (!pull.mergeable || state === "dirty")
    return ["blocked", "There are conflicts that need to be resolved first."];
  if (state === "blocked")
    return [
      "blocked",
      "Branch protection requirements are not met yet (approval or required checks).",
    ];
  if (state === "behind")
    return [
      "blocked",
      "The branch is behind the target branch and needs to be updated first.",
    ];
  // clean, unstable (checks that are not required failed), has_hooks.
  return ["ready", ""];
}

/**
 * The repository's merge method eta uses: squash, a merge commit or rebase, the first the
 * repository allows. Empty when GitHub does not say (the token cannot see the settings): GitHub's
 * default then.
 */
function mergeMethod(repo: RawRepo): string {
  if (repo.allow_squash_merge === true) return "squash";
  if (repo.allow_merge_commit === true) return "merge";
  if (repo.allow_rebase_merge === true) return "rebase";
  return "";
}

/** Reads a pull request's state now. */
export async function readPull(
  github: Github,
  pullUrl: string,
): Promise<GitHubPull> {
  const [owner, name, number] = parsePullUrl(pullUrl);
  const read = await readAs(github, owner, name, number);
  return view(read, read.pull);
}

const staleHead = () =>
  new GithubError(
    "STALE_HEAD",
    409,
    "The PR has new commits after you viewed it, so it was not merged. Please refresh and confirm again.",
  );

/**
 * Merges a pull request if its head is still `headSha`, with the repository's merge method. When
 * the answer is lost (GitHub unreachable, timing out or failing), it reads the pull request again
 * instead of retrying: merged at `headSha` is success, anything else is MERGE_UNKNOWN. Either way
 * the result is the pull request now.
 */
export async function mergePull(
  github: Github,
  pullUrl: string,
  headSha: string,
): Promise<GitHubPull> {
  const [owner, name, number] = parsePullUrl(pullUrl);
  if (headSha.trim() === "")
    throw new GithubError("INVALID_REQUEST", 400, "Missing commits to merge.");
  const read = await readAs(github, owner, name, number);
  const now = view(read, read.pull);
  if (now.state === "merged")
    throw new GithubError(
      "ALREADY_MERGED",
      409,
      "This PR has already been merged.",
    );
  if (now.headSha !== headSha) throw staleHead();
  if (now.merge === "blocked")
    throw new GithubError("NOT_MERGEABLE", 409, now.reason ?? "");
  if (now.state === "closed")
    throw new GithubError(
      "NOT_MERGEABLE",
      409,
      "The PR is closed, so it cannot be merged.",
    );
  // pending: GitHub decides.
  const path = `/repos/${segment(owner)}/${segment(name)}/pulls/${number}`;
  const method = mergeMethod(read.repo);
  try {
    await github.http.api({
      method: "PUT",
      path: `${path}/merge`,
      token: read.reader.token,
      json: {
        sha: headSha,
        ...(method === "" ? {} : { merge_method: method }),
      },
    });
  } catch (error) {
    const status = statusOf(error);
    if (
      status === 409 ||
      (status === 422 && reasons(error).toLowerCase().includes("sha"))
    )
      throw staleHead();
    if (status === 403 || status === 404)
      throw new GithubError(
        "MERGE_FORBIDDEN",
        403,
        `GitHub rejected the merge: no permission (${reasons(error)}).`,
      );
    if (status === 405 || status === 422)
      throw new GithubError(
        "NOT_MERGEABLE",
        409,
        `GitHub rejected the merge: ${reasons(error)}`,
      );
    if (status === 401)
      throw new GithubError(
        "MERGE_FORBIDDEN",
        403,
        "GitHub does not recognize this authorization, so it was not merged.",
      );
    // No answer, or GitHub failed: it may have merged all the same.
    try {
      const check = await github.http.api<RawPull>({
        path,
        token: read.reader.token,
      });
      if (check.merged === true && check.head?.sha === headSha)
        return view(read, check);
    } catch {
      // Unknown, below.
    }
    throw new GithubError(
      "MERGE_UNKNOWN",
      424,
      "No merge result was received from GitHub, and GitHub does not yet show it as merged. Refresh to confirm before deciding whether to retry.",
    );
  }
  // Merged: read it again; failing to is no reason to report the merge as failed.
  try {
    const after = await github.http.api<RawPull>({
      path,
      token: read.reader.token,
    });
    if (after.merged === true) return view(read, after);
  } catch {
    // Reported from what was known.
  }
  const merged: GitHubPull = { ...now, state: "merged" };
  delete merged.merge;
  delete merged.reason;
  return merged;
}
