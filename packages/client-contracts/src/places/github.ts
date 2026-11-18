/**
 * Repositories typed rather than found: a URL, or `owner/repo` by HTTPS or SSH.
 *
 * The shape of the choices follows Paseo (`packages/app/src/add-project-flow/options.ts`,
 * `buildManualGithubRepositoryChoices`, commit `b24eab7`, Apache License 2.0; see `./LICENSE`).
 * What a remote is, and how a shorthand becomes a URL, is not decided here: `hosted-git-info`
 * (npm's own) reads GitHub shorthands and turns them into HTTPS or SSH remotes, and
 * `git-url-parse` reads any other remote git can clone.
 */
import type { RepoChoice } from "./types";
import gitUrlParse from "git-url-parse";
import hostedGitInfo from "hosted-git-info";

/** `owner/repo` (or `github:owner/repo`) on GitHub, when that is what was typed. */
function githubShorthand(value: string) {
  const info = hostedGitInfo.fromUrl(value.trim());
  return info?.type === "github" && info.default === "shortcut"
    ? info
    : undefined;
}

/** A remote git can clone, as written: `https://…`, `ssh://…`, `git@host:…`, `file://…`. */
function parsedRemote(value: string) {
  try {
    const parsed = gitUrlParse(value.trim());
    return parsed.protocols.length > 0 && parsed.protocol !== "github"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Something git can be given: a remote, or a GitHub `owner/repo`. */
export function isCloneable(value: string): boolean {
  return (
    githubShorthand(value) !== undefined || parsedRemote(value) !== undefined
  );
}

export function isGitRemote(value: string): boolean {
  return (
    githubShorthand(value) === undefined && parsedRemote(value) !== undefined
  );
}

/** The repository's directory name: the last part of its remote, without `.git`. */
export function repoName(remote: string): string {
  return (
    githubShorthand(remote)?.project ??
    parsedRemote(remote)?.name ??
    remote.trim()
  );
}

export function manualRepoChoices(query: string): RepoChoice[] {
  const typed = query.trim();
  if (typed === "") return [];
  const shorthand = githubShorthand(typed);
  if (shorthand !== undefined) {
    const nameWithOwner = `${shorthand.user}/${shorthand.project}`;
    return (["https", "ssh"] as const).map((protocol) => ({
      id: `manual:${protocol}:${nameWithOwner}`,
      nameWithOwner,
      cloneUrl: nameWithOwner,
      protocol,
      description: null,
      updatedAt: null,
    }));
  }
  const remote = parsedRemote(typed);
  if (remote === undefined) return [];
  const github = hostedGitInfo.fromUrl(typed);
  return [
    {
      id: `manual:${typed}`,
      nameWithOwner:
        github?.type === "github"
          ? `${github.user}/${github.project}`
          : remote.name,
      cloneUrl: typed,
      description: null,
      updatedAt: null,
    },
  ];
}

/** The URL git is given for a choice: a shorthand by the protocol chosen, a URL as it is. */
export function cloneUrlOf(url: string, protocol?: "https" | "ssh"): string {
  const shorthand = githubShorthand(url);
  if (shorthand === undefined) return url.trim();
  return protocol === "ssh"
    ? shorthand.ssh({ noGitPlus: true })!
    : shorthand.https({ noGitPlus: true })!;
}
