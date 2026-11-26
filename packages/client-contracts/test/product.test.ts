import type {
  AgentCall,
  ConversationCall,
  ConversationSummary,
  MessageView,
  SendResult,
} from "../src/index";
import { describe, expect, it } from "vitest";
import { agentOnlyChat } from "../src/index";

const reply: MessageView = {
  id: "m2",
  conversationId: "c1",
  seq: 2,
  kind: "message",
  author: "agent",
  agentId: "a1",
  text: "",
  thinking: "",
  status: "queued",
  revision: 1,
  mentions: [],
  rootMessageId: "m1",
  replyToId: "m1",
  data: {},
  createdAt: 2,
  updatedAt: 2,
};

describe("the product's targets on the generic pipe", () => {
  it("carries a call and its result as plain JSON", () => {
    const send: ConversationCall = {
      op: "call",
      target: "conversations",
      action: "send",
      requestId: "1",
      args: {
        conversationId: "c1",
        text: "@a1 hello",
        mentions: ["a1"],
        mode: "steer",
        clientId: "client-1",
      },
    };
    const agentCall: AgentCall = {
      op: "call",
      target: "agents",
      action: "delete",
      args: { agentId: "a1" },
    };
    const steward: ConversationCall = {
      op: "call",
      target: "conversations",
      action: "setSteward",
      // Null is a real answer: the group has no steward.
      args: { conversationId: "c1", agentId: null },
    };
    for (const call of [send, agentCall, steward]) {
      expect(JSON.parse(JSON.stringify(call))).toEqual(call);
    }

    const result: SendResult = {
      message: { ...reply, id: "m1", seq: 1, author: "user", agentId: null },
      replies: [reply],
      joined: [],
      nobody: false,
    };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

/** A conversation as a host publishes one: only the fields the predicate reads are asked for. */
const conversation = (
  fields: Pick<ConversationSummary, "kind" | "participants"> &
    Partial<ConversationSummary>,
): ConversationSummary => ({
  id: "c1",
  projectId: "home-a1",
  name: "Ada",
  archived: false,
  stewardId: null,
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

const member = (
  agentId: string,
): ConversationSummary["participants"][number] => ({
  agentId,
  sessionId: null,
  lastSeq: 0,
  status: "idle",
});

describe("an agent's own chat", () => {
  it("is a group whose only member is that agent", () => {
    const chat = conversation({ kind: "group", participants: [member("a1")] });
    expect(agentOnlyChat(chat, "a1")).toBe(true);
    // Somebody else's chat, whatever else is true of it.
    expect(agentOnlyChat(chat, "a2")).toBe(false);
  });

  it("is not a group of two, nor a group of one that is another agent", () => {
    const pair = conversation({
      kind: "group",
      participants: [member("a1"), member("a2")],
    });
    expect(agentOnlyChat(pair, "a1")).toBe(false);
    expect(agentOnlyChat(pair, "a2")).toBe(false);
    expect(
      agentOnlyChat(conversation({ kind: "group", participants: [] }), "a1"),
    ).toBe(false);
  });

  it("is not Captain's own conversation, which is its own kind", () => {
    expect(
      agentOnlyChat(
        conversation({ kind: "captain", participants: [member("captain")] }),
        "captain",
      ),
    ).toBe(false);
  });

  it("is still that chat once it is archived: putting it away is the caller's business", () => {
    expect(
      agentOnlyChat(
        conversation({
          kind: "group",
          participants: [member("a1")],
          archived: true,
        }),
        "a1",
      ),
    ).toBe(true);
  });
});
