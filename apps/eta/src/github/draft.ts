/**
 * An issue draft is an issue the user files themself: GitHub's new-issue page with the title and
 * body filled in, for when the agent may not create it. Nothing is written to GitHub and nothing
 * is kept.
 */
import { GithubError } from "./error";
import { parseRepository } from "./service";

export interface IssueDraft {
  repository: string;
  title: string;
  /** The new-issue page, prefilled. */
  url: string;
  /**
   * Set when the body would make the link too long for browsers and GitHub: the link fills in the
   * title only, and the user pastes this.
   */
  body?: string;
}

/** GitHub's owner and repository names; anything else is not a repository a link may point into. */
const REPO_NAME = /^[A-Z0-9-]+\/[\w.-]+$/i;

/** How long a prefilled link may get: GitHub answers longer ones with an error page. */
const MAX_DRAFT_URL = 8000;

/** GitHub's limits on an issue's title and body, in characters. */
const MAX_ISSUE_TITLE = 256;
const MAX_ISSUE_BODY = 65536;

const characters = (text: string): number => [...text].length;

/** A query value escaped the way a link may carry it: everything but `-_.~`, spaces as %20. */
function escape(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value))
    out += /[\w\-.~]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

export function newIssueDraft(input: {
  repository: string;
  title: string;
  body?: string | undefined;
}): IssueDraft {
  const [owner, name] = parseRepository(input.repository);
  const repository = `${owner}/${name}`;
  if (!REPO_NAME.test(repository) || repository.includes(".."))
    throw new GithubError(
      "INVALID_REPOSITORY",
      400,
      `Unrecognized repository ${input.repository}, please write it as owner/name.`,
    );
  const title = input.title.trim();
  const body = input.body ?? "";
  if (title === "") throw new GithubError("INVALID_ISSUE", 400, "Missing title.");
  if (characters(title) > MAX_ISSUE_TITLE)
    throw new GithubError(
      "INVALID_ISSUE",
      400,
      "Title too long: GitHub issue titles are at most 256 characters.",
    );
  if (characters(body) > MAX_ISSUE_BODY)
    throw new GithubError(
      "INVALID_ISSUE",
      400,
      "Body too long: GitHub issue bodies are at most 65536 characters.",
    );
  // The fields in key order, as a query string is written.
  const link = (fields: [string, string][]): string =>
    `https://github.com/${repository}/issues/new?${fields
      .map(([key, value]) => `${key}=${escape(value)}`)
      .join("&")}`;
  const fields: [string, string][] = [["title", title]];
  if (body !== "") fields.unshift(["body", body]);
  const draft: IssueDraft = { repository, title, url: link(fields) };
  if (draft.url.length > MAX_DRAFT_URL) {
    // A title GitHub takes always fits.
    draft.url = link([["title", title]]);
    draft.body = body;
  }
  return draft;
}
