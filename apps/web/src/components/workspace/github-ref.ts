import type { ActivityRef } from "./activity-ref";
import type { ToolBlock } from "@/lib/run";

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
