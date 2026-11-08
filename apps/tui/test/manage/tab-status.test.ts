/**
 * A conversation tab's mark: running and waiting come from the list's members; done and failed
 * from the conversation's own target, for a reply the user has not read.
 */
import type {
  ConversationInfo,
  ConversationSummary,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { WireState } from "../../src/connection/types";
import { describe, expect, it } from "vitest";
import { conversationTabStatus } from "../../src/ext/conversation/facts";

const ID = "c1";

function member(status: MemberView["status"]): MemberView {
  return { agentId: "a1", sessionId: null, lastSeq: 0, status };
}

function summary(participants: MemberView[]): ConversationSummary {
  return {
    id: ID,
    projectId: "p",
    kind: "group",
    name: "Group",
    archived: false,
    stewardId: null,
    participants,
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function row(
  seq: number,
  author: MessageView["author"],
  status: MessageView["status"],
): MessageView {
  return {
    id: `m${seq}`,
    conversationId: ID,
    seq,
    kind: "message",
    author,
    agentId: author === "agent" ? "a1" : null,
    text: "",
    thinking: "",
    status,
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: seq,
    updatedAt: seq,
  };
}

function info(readSeq: number): ConversationInfo {
  return {
    id: ID,
    projectId: "p",
    kind: "group",
    name: "Group",
    goal: "",
    decided: "",
    archived: false,
    stewardId: null,
    stewardOverrideId: null,
    noSteward: false,
    readSeq,
    lastSeq: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function state(
  participants: MemberView[],
  target?: { readSeq: number; rows: MessageView[] },
): WireState {
  const targets: WireState["targets"] = {
    conversations: {
      sections: { list: [summary(participants)] },
      revisions: {},
      version: 1,
    },
  };
  if (target !== undefined)
    targets[`conversations.${ID}`] = {
      sections: {
        info: info(target.readSeq),
        members: participants,
        timeline: { messages: target.rows, hasMore: false, held: [] },
      },
      revisions: {},
      version: 1,
    };
  return {
    status: "open",
    ops: [],
    mounted: [],
    targets,
    missing: {},
    error: undefined,
  };
}

describe("conversationTabStatus", () => {
  it("is running or waiting from the members, ahead of a finished reply", () => {
    const finished = { readSeq: 0, rows: [row(1, "agent", "done")] };
    expect(
      conversationTabStatus(state([member("working")], finished), ID),
    ).toBe("running");
    expect(
      conversationTabStatus(
        state([member("idle"), member("waiting_for_input")], finished),
        ID,
      ),
    ).toBe("waiting");
  });

  it("looks at the newest agent row only, past later user rows", () => {
    expect(
      conversationTabStatus(
        state([member("idle")], {
          readSeq: 1,
          rows: [
            row(1, "agent", "done"),
            row(2, "agent", "failed"),
            row(3, "user", "done"),
          ],
        }),
        ID,
      ),
    ).toBe("failed");
    expect(
      conversationTabStatus(
        state([member("idle")], {
          readSeq: 0,
          rows: [row(1, "agent", "failed"), row(2, "agent", "done")],
        }),
        ID,
      ),
    ).toBe("done");
  });

  it("draws nothing for a reply that was stopped", () => {
    expect(
      conversationTabStatus(
        state([member("idle")], {
          readSeq: 0,
          rows: [row(1, "agent", "stopped")],
        }),
        ID,
      ),
    ).toBeUndefined();
  });

  it("falls back to the members alone before the target arrives", () => {
    expect(conversationTabStatus(state([member("idle")]), ID)).toBeUndefined();
    expect(conversationTabStatus(state([member("queued")]), ID)).toBe(
      "running",
    );
  });
});
