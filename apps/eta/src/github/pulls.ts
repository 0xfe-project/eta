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
      `${value} 不是 GitHub 的 PR 链接。`,
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
      "GitHub 上看不到这个 PR：App 或你的账号没有这个仓库的权限，或 PR 已不存在。",
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
    p.reason = "草稿 PR 不能合并，请先在 GitHub 上标为可审阅。";
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
    return ["blocked", "你的 GitHub 账号没有这个仓库的写权限，不能合并。"];
  if (mergeMethod(repo) === "" && repo.allow_merge_commit !== undefined)
    return ["blocked", "仓库没有允许任何合并方式。"];
  const state = pull.mergeable_state ?? "";
  if (
    pull.mergeable === undefined ||
    pull.mergeable === null ||
    state === "unknown" ||
    state === ""
  )
    return ["pending", "GitHub 还在计算能否合并，稍后刷新。"];
  if (!pull.mergeable || state === "dirty")
    return ["blocked", "有冲突，需要先解决。"];
  if (state === "blocked")
    return ["blocked", "分支保护的要求还没满足（审批或必需的检查）。"];
  if (state === "behind")
    return ["blocked", "分支落后于目标分支，需要先更新。"];
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
    "PR 在你查看之后又有了新提交，没有合并。请刷新后再确认。",
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
    throw new GithubError("INVALID_REQUEST", 400, "缺少要合并的提交。");
  const read = await readAs(github, owner, name, number);
  const now = view(read, read.pull);
  if (now.state === "merged")
    throw new GithubError("ALREADY_MERGED", 409, "这个 PR 已经合并了。");
  if (now.headSha !== headSha) throw staleHead();
  if (now.merge === "blocked")
    throw new GithubError("NOT_MERGEABLE", 409, now.reason ?? "");
  if (now.state === "closed")
    throw new GithubError("NOT_MERGEABLE", 409, "PR 已关闭，不能合并。");
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
        `GitHub 拒绝合并：没有权限（${reasons(error)}）。`,
      );
    if (status === 405 || status === 422)
      throw new GithubError(
        "NOT_MERGEABLE",
        409,
        `GitHub 拒绝合并：${reasons(error)}`,
      );
    if (status === 401)
      throw new GithubError(
        "MERGE_FORBIDDEN",
        403,
        "GitHub 不认这次的授权，没有合并。",
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
      "没有得到 GitHub 的合并结果，GitHub 上暂时也没显示已合并。请刷新确认后再决定是否重试。",
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
