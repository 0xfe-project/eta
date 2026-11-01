import type { EmailThreadView } from "@eta/client-contracts";
import { describe, expect, it } from "@rstest/core";
import { emailThreadsForFolder } from "./email-folders";

const thread = (
  fields: Partial<EmailThreadView> &
    Pick<EmailThreadView, "id" | "incomingCount" | "outgoingCount">,
): EmailThreadView => ({
  accountId: "mail-1",
  peer: "sender@example.com",
  subject: "[eta-mp] Test",
  status: "new",
  unread: false,
  messageCount: fields.incomingCount + fields.outgoingCount,
  lastMessageAt: 1,
  lastMessage: "Test",
  rootMessageId: null,
  latestMessageId: null,
  ...fields,
});

describe("email folders", () => {
  it("separates threads with directional counts", () => {
    const incoming = thread({
      id: "incoming",
      incomingCount: 1,
      outgoingCount: 0,
    });
    const outgoing = thread({
      id: "outgoing",
      incomingCount: 0,
      outgoingCount: 1,
    });
    expect(emailThreadsForFolder([incoming, outgoing], "inbox")).toEqual([
      incoming,
    ]);
    expect(emailThreadsForFolder([incoming, outgoing], "sent")).toEqual([
      outgoing,
    ]);
  });

  it("does not duplicate unknown-direction mail into sent", () => {
    const unknown = {
      ...thread({
        id: "unknown",
        incomingCount: 0,
        outgoingCount: 0,
      }),
      incomingCount: undefined,
      outgoingCount: undefined,
    } as unknown as EmailThreadView;
    expect(emailThreadsForFolder([unknown], "inbox")).toEqual([unknown]);
    expect(emailThreadsForFolder([unknown], "sent")).toEqual([]);
  });
});
