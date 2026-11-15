import type { EmailProposalView } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, mount } from "@/test-render";
import { EmailProposalCard } from "./email-proposal-card";

const proposal: EmailProposalView = {
  id: "proposal-1",
  threadId: null,
  replyToMessageId: null,
  sessionId: "session-1",
  agentId: "agent-1",
  accountId: "mail-1",
  kind: "new",
  status: "pending",
  from: "alice@example.com",
  to: "bob@example.com",
  cc: "",
  bcc: "",
  subject: "[eta-mp] Project update",
  markdown: "# Update",
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("email proposal card", () => {
  function host(value: EmailProposalView = proposal) {
    buildProductHost({}, ["email"])
      .target("email", {
        accounts: [],
        threads: [],
        proposals: [value],
        stats: {
          unread: 0,
          pendingProposals: value.status === "pending" ? 1 : 0,
        },
      })
      .install()
      .hello();
  }

  it("labels each field it lets the user check before sending", async () => {
    host();
    const view = await mount(<EmailProposalCard proposalId={proposal.id} />);
    // Each field sits inside its label, so the label is the field's accessible name.
    const fields = [...view.container.querySelectorAll("label")].map(
      (label) => {
        const field = label.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >("input, textarea")!;
        // The label's own words: its text without the textarea's contents.
        const words = label.textContent!.slice(
          0,
          label.textContent!.length - (field.textContent ?? "").length,
        );
        return [words, field.value];
      },
    );
    expect(fields).toEqual([
      ["收件人", "bob@example.com"],
      ["主题", "[eta-mp] Project update"],
      ["正文", "# Update"],
    ]);
  });

  it("warns when an unsent proposal is collapsed", async () => {
    host();
    const view = await mount(<EmailProposalCard proposalId={proposal.id} />);
    const toggle = view.container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="true"]',
    )!;
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelector("input")).toBeNull();
    expect(view.container.textContent).toContain(
      "尚未发送，请展开检查内容并确认发送",
    );
    const hint = [...view.container.querySelectorAll("button")].find(
      (candidate) =>
        candidate.textContent?.includes("尚未发送，请展开检查内容并确认发送"),
    );
    await click(hint);
    expect(view.container.querySelector("input")).not.toBeNull();
  });

  it("starts a sent proposal collapsed and can expand it", async () => {
    const sent = { ...proposal, status: "accepted" as const };
    host(sent);
    const view = await mount(<EmailProposalCard proposalId={proposal.id} />);
    const toggle = view.container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    )!;
    expect(view.container.textContent).toContain("邮件已发送");
    expect(view.container.querySelector("input")).toBeNull();
    await click(toggle);
    expect(view.container.querySelector("input")?.disabled).toBe(true);
  });
});
