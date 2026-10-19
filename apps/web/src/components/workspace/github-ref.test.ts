import type { ToolBlock } from "@/lib/run";
import { describe, expect, it } from "@rstest/core";
import { githubRef } from "./github-ref";

const block = (fields: Partial<ToolBlock>): ToolBlock =>
  ({
    type: "tool",
    id: "c1",
    name: "open_pull_request",
    status: "completed",
    input: {},
    ...fields,
  }) as ToolBlock;

describe("the card under a GitHub tool call", () => {
  it("links the pull request an agent opened, titled when the call made it", () => {
    const url = "https://github.com/akarachen/eta/pull/7";
    expect(
      githubRef(
        block({
          details: { kind: "pull_request", number: 7, url, title: "Add" },
        }),
      ),
    ).toEqual({ kind: "pull_request", number: 7, url, title: "Add" });
    // One that was already open keeps the title it has on GitHub.
    expect(
      githubRef(block({ details: { kind: "pull_request", number: 7, url } })),
    ).toEqual({ kind: "pull_request", number: 7, url, title: "" });
  });

  it("offers an issue draft as the thing to file, with its body when the link left it out", () => {
    const url = "https://github.com/akarachen/eta/issues/new?title=Bug";
    expect(
      githubRef(
        block({
          name: "draft_issue",
          details: { kind: "issue_draft", title: "Bug", url, body: "很长" },
        }),
      ),
    ).toEqual({ kind: "issue_draft", title: "Bug", url, body: "很长" });
  });

  it("shows nothing for a call that failed, another tool, or a result without its thing", () => {
    const details = {
      kind: "pull_request",
      number: 7,
      url: "https://x/pull/7",
    };
    expect(githubRef(block({ status: "failed", details }))).toBeUndefined();
    expect(githubRef(block({ name: "bash", details }))).toBeUndefined();
    expect(githubRef(block({}))).toBeUndefined();
    expect(
      githubRef(
        block({
          name: "draft_issue",
          details: { kind: "pull_request", url: "u" },
        }),
      ),
    ).toBeUndefined();
  });
});
