import type { MessageView } from "../src/index";
import { describe, expect, it } from "vitest";
import { captainProposalOf, isCaptainOutcome } from "../src/index";

const OPERATION = "6f1c2a3b-0d4e-4f5a-8b6c-7d8e9f0a1b2c";

const message = (fields: Partial<MessageView>): MessageView => ({
  id: "m1",
  conversationId: "c1",
  seq: 1,
  kind: "message",
  author: "system",
  agentId: null,
  text: "",
  thinking: "",
  status: "done",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: {},
  createdAt: 0,
  updatedAt: 0,
  ...fields,
});

describe("the message that tells Captain how a proposal ended", () => {
  it.each(["captainOutcome", "captainGroupOutcome", "captainAgentOutcome"])(
    "is known by its mark, %s included",
    (key) => {
      const marked = message({
        text: "anything",
        data: { [key]: { operationId: OPERATION, status: "applied" } },
      });
      expect(isCaptainOutcome(marked)).toBe(true);
      expect(isCaptainOutcome({ ...marked, author: "user" })).toBe(false);
      expect(isCaptainOutcome({ ...marked, kind: "system" })).toBe(false);
    },
  );

  it.each([
    `Your proposed group "Launch" (operation ${OPERATION}) was confirmed by the user and created.\nconversationId: c2`,
    `Your proposed group "a "quoted" name" (operation ${OPERATION}) was rejected by the user. Nothing was created.`,
    `Your proposed group "Launch" (operation ${OPERATION}) was confirmed by the user, but creating it failed: boom. Nothing was created.`,
  ])("is known by its opening when written before the mark: %s", (text) => {
    expect(isCaptainOutcome(message({ text }))).toBe(true);
  });

  it("is only ever a system message", () => {
    const text = `Your proposed group "Launch" (operation ${OPERATION}) was rejected by the user.`;
    expect(isCaptainOutcome(message({ author: "user", text }))).toBe(false);
    expect(
      isCaptainOutcome(message({ author: "agent", agentId: "a1", text })),
    ).toBe(false);
    expect(isCaptainOutcome(message({ kind: "system", text }))).toBe(false);
    expect(isCaptainOutcome(message({ text: `Quoting it: ${text}` }))).toBe(
      false,
    );
    expect(
      isCaptainOutcome(
        message({ text: "<captain-review>\n</captain-review>" }),
      ),
    ).toBe(false);
    expect(isCaptainOutcome(message({ text: "hi" }))).toBe(false);
  });
});

describe("a proposal card's row", () => {
  const proposal = { name: "Launch" };

  it("is read for any kind", () => {
    expect(
      captainProposalOf(
        message({
          kind: "system",
          data: {
            event: "captain_proposal",
            kind: "create_thing",
            operationId: OPERATION,
            proposal,
          },
        }),
      ),
    ).toEqual({ kind: "create_thing", operationId: OPERATION, proposal });
  });

  it.each([
    ["captain_group_proposal", "create_group"],
    ["captain_agent_proposal", "create_agent"],
  ])("is read from the older event %s as %s", (event, kind) => {
    expect(
      captainProposalOf(
        message({
          kind: "system",
          data: { event, operationId: OPERATION, proposal },
        }),
      ),
    ).toEqual({ kind, operationId: OPERATION, proposal });
  });

  it("is nothing for another row, or one missing what a card needs", () => {
    for (const data of [
      {},
      { event: "steward", to: "a1" },
      { event: "captain_proposal", operationId: OPERATION, proposal },
      { event: "captain_proposal", kind: "create_group", proposal },
      { event: "captain_group_proposal", operationId: OPERATION },
    ])
      expect(
        captainProposalOf(message({ kind: "system", data })),
        JSON.stringify(data),
      ).toBeUndefined();
  });
});
