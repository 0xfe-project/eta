import type { ActivityRef } from "./activity-ref";
import type { ToolBlock } from "@/lib/run";
import { useGitHubMounted } from "@/queries/github";

/**
 * The card under a GitHub tool call: the pull request `open_pull_request` opened, or the issue
 * `draft_issue` drafted (not an issue yet: the card opens GitHub's prefilled new-issue page). The
 * tool names the one thing it made in its result's `details`; anything else shows no card.
 */
export function githubRef(block: ToolBlock): ActivityRef | undefined {
  if (block.status !== "completed") return undefined;
  const details = (block.details ?? {}) as Record<string, unknown>;
  const { kind, url, title, number, body } = details;
  if (typeof url !== "string") return undefined;
  if (block.name === "open_pull_request" && kind === "pull_request")
    return {
      kind,
      url,
      title: typeof title === "string" ? title : "",
      ...(typeof number === "number" ? { number } : {}),
    };
  if (
    block.name === "draft_issue" &&
    kind === "issue_draft" &&
    typeof title === "string"
  )
    return {
      kind,
      url,
      title,
      ...(typeof body === "string" ? { body } : {}),
    };
  return undefined;
}

/**
 * The same card, seen from a page: what the host has decides.
 *
 * A pull request an agent opened years ago is still in that conversation's timeline, with its
 * address in the tool's result. When the host has no GitHub plugin, that row draws no card at all.
 * The rule is deliberate: a card that leads to another system, from a host which cannot say
 * anything about it and did not make it, reads as a feature that is still here — and a half-shown
 * one is worse than none. So it is not drawn: no empty frame, no spinner, no error in the console.
 * Start the host with GitHub and the same row draws its card again.
 */
export function useGitHubRef(block: ToolBlock): ActivityRef | undefined {
  return useGitHubMounted() ? githubRef(block) : undefined;
}
