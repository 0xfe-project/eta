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

  it("keeps its labels on one line beside the fields", async () => {
    host();
    const view = await mount(<EmailProposalCard proposalId={proposal.id} />);
    const labels = [
      ...view.container.querySelectorAll<HTMLElement>(
        '[data-slot="label"] > span:first-child',
      ),
    ];
    expect(labels.map((label) => label.textContent)).toEqual([
      "收件人",
      "主题",
      "正文",
    ]);
    expect(labels).toHaveLength(3);
    for (const label of labels) {
      expect(label.classList.contains("shrink-0")).toBe(true);
      expect(label.classList.contains("whitespace-nowrap")).toBe(true);
      expect(label.classList.contains("text-right")).toBe(true);
      expect(
        label.parentElement?.classList.contains(
          "grid-cols-[3rem_minmax(0,1fr)]",
        ),
      ).toBe(true);
      expect(label.parentElement?.classList.contains("gap-1")).toBe(true);
    }
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
