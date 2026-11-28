/**
 * A conversation tab's steward name when the host's lists cannot give one: a steward the agents
 * list does not have, or a conversation not listed. The names drawn in the tab bar are checked on a
 * real host in tab-names-host.test.tsx.
 */
import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import type { WireState } from "../../src/connection/types";
import { describe, expect, it } from "vitest";
import { conversationStewardName } from "../../src/ext/conversation/facts";

const ID = "3f2a9c41-7d0e-4b6a-9f1e-2c5d8a7b6e10";

function summary(stewardId: string | null): ConversationSummary {
  return {
    id: ID,
    projectId: "p",
    kind: "group",
    name: "demo-project",
    archived: false,
    stewardId,
    participants: [],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function agent(id: string, name: string): AgentView {
  return { id, name } as AgentView;
}

function wireState(
  conversations: ConversationSummary[],
  agents: AgentView[],
): WireState {
  return {
    targets: {
      conversations: { sections: { list: conversations } },
      agents: { sections: { list: agents } },
    },
  } as unknown as WireState;
}

describe("a conversation's steward name", () => {
  it("is undefined when the agents list does not have the steward", () => {
    const state = wireState([summary("a1")], [agent("a2", "Ben")]);
    expect(conversationStewardName(state, ID)).toBeUndefined();
  });

  it("is undefined while the conversation is not listed", () => {
    const state = wireState([], [agent("a1", "Ada")]);
    expect(conversationStewardName(state, ID)).toBeUndefined();
  });
});
