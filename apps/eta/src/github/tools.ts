/**
 * The tools of the GitHub App: `open_pull_request` and `draft_issue`, what the original forge MCP
 * server (`/forge/mcp`) served. They are session tools rather than an MCP server of their own: the
 * host already owns every session's tool list, the tools run in this process (so on a daemon's
 * session they run here too, over `tool.call`, with the App's secrets staying put), and no MCP
 * client, port or credentials are needed to reach what is in the same process.
 *
 * What a model reads is the description and nothing else, so the descriptions are the original's.
 * The result names the one thing a call made in its `details` (`ref`, which the web shows as a
 * card under the call): `pull_request`, or `issue_draft` for an issue that is not one yet.
 */
import type { KernelTool } from "@eta/core";
import type { ToolResult } from "@eta/harness";
import type { SessionHooks } from "../session-hooks";
import type { Github } from "./service";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";
import { newIssueDraft } from "./draft";
import { messageOf } from "./error";

/** What the call made, for the transcript's card. */
type GithubRef =
  | {
      kind: "pull_request";
      number: number;
      url: string;
      /** Set when the call made it; an open one found keeps the title it has on GitHub. */
      title?: string;
    }
  | { kind: "issue_draft"; title: string; url: string; body?: string };

const failure = (error: unknown): ToolResult => toolError(messageOf(error));

export function githubSessionTools(deps: {
  github: Github;
  /** A pull request an agent opened in a conversation: tell the task it belongs to. */
  opened: (conversationId: string | undefined, pull: OpenedPull) => void;
}): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => githubTools(deps, meta.conversationId);
}

export interface OpenedPull {
  url: string;
  number: number;
  title: string;
}

function githubTools(
  deps: Parameters<typeof githubSessionTools>[0],
  conversationId: string | undefined,
): KernelTool[] {
  const open = defineTool({
    name: "open_pull_request",
    label: "open_pull_request",
    description:
      "Open a GitHub pull request through eta's GitHub App.\n\n" +
      'Push the branch first. repository is "owner/name" or the remote URL ' +
      "(`git remote get-url origin`); head is the pushed branch; base defaults " +
      "to the repository's default branch. If a pull request for head is " +
      "already open, it is returned instead. Use it instead of `gh pr create`.",
    parameters: Type.Object({
      repository: Type.String({
        description:
          '"owner/name" or the remote URL (git remote get-url origin)',
      }),
      head: Type.String({ description: "the pushed branch" }),
      title: Type.String(),
      body: Type.Optional(Type.String()),
      base: Type.Optional(
        Type.String({
          description: "defaults to the repository's default branch",
        }),
      ),
      draft: Type.Optional(Type.Boolean()),
    }),
    async execute(args) {
      try {
        const pull = await deps.github.openPullRequest(args);
        deps.opened(conversationId, {
          url: pull.url,
          number: pull.number,
          title: args.title,
        });
        const ref: GithubRef = {
          kind: "pull_request",
          number: pull.number,
          url: pull.url,
          ...(pull.created ? { title: args.title } : {}),
        };
        return text(JSON.stringify(pull), ref);
      } catch (error) {
        return failure(error);
      }
    },
  });

  const draft = defineTool({
    name: "draft_issue",
    label: "draft_issue",
    description:
      "Draft a GitHub issue for the user to file: eta shows it as a card that opens GitHub's " +
      "new-issue page with the title and body filled in, and the user reviews and submits it. Nothing is " +
      "written to GitHub. Use it when you may not create the issue yourself.",
    parameters: Type.Object({
      repository: Type.String({
        description: '"owner/name" or the remote URL',
      }),
      title: Type.String(),
      body: Type.Optional(Type.String({ description: "in Markdown" })),
    }),
    execute(args) {
      try {
        const issue = newIssueDraft(args);
        // Not an issue yet: the transcript offers to file it, and the body comes along only when
        // the link leaves it out.
        const ref: GithubRef = {
          kind: "issue_draft",
          title: issue.title,
          url: issue.url,
          ...(issue.body === undefined || issue.body === ""
            ? {}
            : { body: issue.body }),
        };
        return text(JSON.stringify(issue), ref);
      } catch (error) {
        return failure(error);
      }
    },
  });

  // These tools call GitHub, not files: they need no execution environment.
  const none = (): undefined => undefined;
  return [toKernelTool(open, none), toKernelTool(draft, none)] as KernelTool[];
}
