import type {
  AgentView,
  ConversationKind,
  ConversationSummary,
} from "@eta/client-contracts";
import type { WireState } from "../../src/connection/types";
import { describe, expect, it } from "vitest";
import { conversationList } from "../../src/ext/conversation/facts";

const row = (
  id: string,
  kind: ConversationKind,
  agentId: string,
): ConversationSummary => ({
  id,
  projectId: "p",
  kind,
  name: id,
  archived: false,
  stewardId: agentId,
  participants: [{ agentId, sessionId: null, lastSeq: 0, status: "idle" }],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
});

const agents = [
  { id: "cap", name: "Captain", systemRole: "captain" },
  { id: "ada", name: "Ada", systemRole: null },
] as AgentView[];

const state = (list: ConversationSummary[]) =>
  ({
    targets: {
      conversations: { sections: { list }, revisions: {}, version: 0 },
      agents: { sections: { list: agents }, revisions: {}, version: 0 },
    },
  }) as unknown as WireState;

describe("the conversations the TUI lists", () => {
  it("leave out Captain's conversation by its kind", () => {
    const listed = conversationList(
      state([
        row("captain-chat", "captain", "cap"),
        row("web", "group", "ada"),
      ]),
    );
    expect(listed.map((c) => c.id)).toEqual(["web"]);
  });

  it("keep a group of one whose member is an ordinary agent", () => {
    const listed = conversationList(state([row("ada-alone", "group", "ada")]));
    expect(listed.map((c) => c.id)).toEqual(["ada-alone"]);
  });

  it("leave out Captain's own chat when a host lists it as the group of one it is", () => {
    const listed = conversationList(
      state([row("old-captain", "group", "cap"), row("web", "group", "ada")]),
    );
    expect(listed.map((c) => c.id)).toEqual(["web"]);
  });
});
