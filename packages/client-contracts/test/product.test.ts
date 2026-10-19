import type { StateSnapshot } from "@eta/client-wire-proto";
import type {
  AgentCall,
  ConversationCall,
  ConversationSections,
  ConversationSummary,
  MessageView,
  ProjectCall,
  SendResult,
} from "../src/index";
import { encodeFrame, stateDiff } from "@eta/client-wire-proto";
import { describe, expect, it } from "vitest";
import {
  AGENT_ACTIONS,
  CONVERSATION_ACTIONS,
  MACHINE_ACTIONS,
  PROJECT_ACTIONS,
} from "../src/index";

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
  it("lists the actions each target has, once", () => {
    for (const actions of [
      AGENT_ACTIONS,
      MACHINE_ACTIONS,
      PROJECT_ACTIONS,
      CONVERSATION_ACTIONS,
    ]) {
      expect(new Set(actions).size).toBe(actions.length);
    }
    expect(AGENT_ACTIONS).toContain("direct");
    expect(PROJECT_ACTIONS).toContain("setSteward");
    expect(CONVERSATION_ACTIONS).toEqual(
      expect.arrayContaining(["send", "stop", "read", "history"]),
    );
  });

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

  it("diffs a conversation's sections the way it diffs a session's", () => {
    const summary: ConversationSummary = {
      id: "c1",
      projectId: "p1",
      kind: "group",
      name: "plans",
      archived: false,
      stewardId: "a1",
      participants: [
        { agentId: "a1", sessionId: null, lastSeq: 0, status: "idle" },
      ],
      lastSeq: 2,
      readSeq: 0,
      unread: 1,
      preview: "hello",
      lastMessageAt: 2,
      createdAt: 1,
      updatedAt: 2,
    };
    const sections: ConversationSections = {
      info: {
        id: "c1",
        projectId: "p1",
        kind: "group",
        name: "plans",
        goal: "",
        decided: "",
        archived: false,
        stewardId: "a1",
        stewardOverrideId: null,
        readSeq: 0,
        lastSeq: 2,
        createdAt: 1,
        updatedAt: 2,
      },
      members: summary.participants,
      timeline: { messages: [reply], hasMore: false },
    };
    const snapshot: StateSnapshot = {
      sections: { ...sections },
      revisions: { info: "1", members: "1", timeline: "1" },
    };
    expect(stateDiff(undefined, snapshot)).toBe("full");
    const next = {
      sections: {
        ...sections,
        timeline: {
          messages: [{ ...reply, status: "working", revision: 2 }],
          hasMore: false,
        },
      },
      revisions: { info: "1", members: "1", timeline: "2" },
    };
    const patch = stateDiff(snapshot.revisions, next);
    expect(patch).toEqual({
      sections: { timeline: next.sections.timeline },
      revisions: next.revisions,
    });
    expect(
      JSON.parse(
        encodeFrame({
          type: "state",
          target: "conversations.c1",
          version: 2,
          patch: patch as Exclude<typeof patch, "full" | undefined>,
        }),
      ),
    ).toMatchObject({ target: "conversations.c1", version: 2 });
  });
});
