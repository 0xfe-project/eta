import type { MessageView } from "../src/index";
import { describe, expect, it } from "vitest";
import {
  isCaptainAgentOutcome,
  isCaptainGroupOutcome,
  isCaptainOutcome,
} from "../src/index";

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

describe("the message that tells Captain how its group proposal ended", () => {
  it("is known by its mark", () => {
    expect(
      isCaptainGroupOutcome(
        message({
          text: "anything",
          data: {
            captainGroupOutcome: { operationId: OPERATION, status: "applied" },
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    `Your proposed group "Launch" (operation ${OPERATION}) was confirmed by the user and created.\nconversationId: c2`,
    `Your proposed group "a "quoted" name" (operation ${OPERATION}) was rejected by the user. Nothing was created.`,
    `Your proposed group "Launch" (operation ${OPERATION}) was confirmed by the user, but creating it failed: boom. Nothing was created.`,
  ])("is known by its opening when written before the mark: %s", (text) => {
    expect(isCaptainGroupOutcome(message({ text }))).toBe(true);
  });

  it("is only ever a system message", () => {
    const text = `Your proposed group "Launch" (operation ${OPERATION}) was rejected by the user.`;
    expect(isCaptainGroupOutcome(message({ author: "user", text }))).toBe(
      false,
    );
    expect(
      isCaptainGroupOutcome(message({ author: "agent", agentId: "a1", text })),
    ).toBe(false);
    expect(isCaptainGroupOutcome(message({ kind: "system", text }))).toBe(
      false,
    );
    expect(
      isCaptainGroupOutcome(message({ text: `Quoting it: ${text}` })),
    ).toBe(false);
    expect(
      isCaptainGroupOutcome(
        message({ text: "<captain-review>\n</captain-review>" }),
      ),
    ).toBe(false);
  });
});

describe("the message that tells Captain how its agent proposal ended", () => {
  it("is known by its mark, and only as a system message", () => {
    const marked = message({
      data: {
        captainAgentOutcome: { operationId: OPERATION, status: "applied" },
      },
    });
    expect(isCaptainAgentOutcome(marked)).toBe(true);
    expect(isCaptainAgentOutcome({ ...marked, author: "user" })).toBe(false);
    expect(isCaptainAgentOutcome({ ...marked, kind: "system" })).toBe(false);
  });

  it("is not a group's outcome, and a group's is not its", () => {
    const agent = message({
      data: {
        captainAgentOutcome: { operationId: OPERATION, status: "rejected" },
      },
    });
    const group = message({
      data: {
        captainGroupOutcome: { operationId: OPERATION, status: "rejected" },
      },
    });
    expect(isCaptainGroupOutcome(agent)).toBe(false);
    expect(isCaptainAgentOutcome(group)).toBe(false);
  });

  it("is what isCaptainOutcome answers for, either kind", () => {
    expect(
      isCaptainOutcome(
        message({
          data: {
            captainAgentOutcome: { operationId: OPERATION, status: "failed" },
          },
        }),
      ),
    ).toBe(true);
    expect(
      isCaptainOutcome(
        message({
          data: {
            captainGroupOutcome: { operationId: OPERATION, status: "applied" },
          },
        }),
      ),
    ).toBe(true);
    // A plain system message is neither.
    expect(isCaptainOutcome(message({ text: "hi" }))).toBe(false);
  });
});
