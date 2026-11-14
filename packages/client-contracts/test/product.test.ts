import type {
  AgentCall,
  ConversationCall,
  MessageView,
  ProjectCall,
  SendResult,
} from "../src/index";
import { describe, expect, it } from "vitest";

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
    const direct: AgentCall = {
      op: "call",
      target: "agents",
      action: "direct",
      args: { agentId: "a1" },
    };
    const steward: ProjectCall = {
      op: "call",
      target: "projects",
      action: "setSteward",
      // Null is a real answer: the project follows nobody.
      args: { projectId: "p1", agentId: null },
    };
    for (const call of [send, direct, steward]) {
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
