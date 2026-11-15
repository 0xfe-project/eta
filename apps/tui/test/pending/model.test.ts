/**
 * What is waiting and in what order, computed from the wire's state alone: which questions and
 * tasks count, the panel's conversations, the open tasks of `/tasks`, and which conversation an
 * item belongs to.
 */
import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  ConversationSummary,
  InteractionStatus,
  InteractionView,
} from "@eta/client-contracts";
import type { WireState } from "../../src/connection/types";
import { describe, expect, it } from "vitest";
import {
  itemConversationId,
  openTasks,
  panelConversations,
  pendingCount,
  pendingItems,
} from "../../src/ext/pending/model";

function question(
  id: string,
  createdAt: number,
  status: InteractionStatus = "pending",
  conversationId: string | null = "c1",
): InteractionView {
  return {
    id,
    sessionId: `session-${id}`,
    questionId: `q-${id}`,
    agentId: "a1",
    conversationId,
    replyId: null,
    prompt: `Question ${id}`,
    options: [],
    multi: false,
    status,
    answer: null,
    revision: 1,
    createdAt,
    // A question's time is when it was asked; this is set to mislead an order by it.
    updatedAt: 10_000_000 - createdAt,
  };
}

function task(
  id: string,
  status: BoardTaskStatus,
  updatedAt: number,
  conversationId: string | null = null,
): BoardTaskView {
  return {
    id,
    number: Number(id.replace(/\D/g, "")) || 1,
    title: `Task ${id}`,
    status,
    createdBy: { kind: "agent", agentId: "a1" },
    assigneeAgentId: null,
    conversationId,
    runStatus: null,
    comments: 0,
    // A task's time is its last change; this is set to mislead an order by creation.
    createdAt: 10_000_000 - updatedAt,
    updatedAt,
  };
}

function conversation(
  id: string,
  lastMessageAt: number | null,
  updatedAt: number,
  archived = false,
): ConversationSummary {
  return {
    id,
    projectId: "p1",
    kind: "group",
    name: id,
    archived,
    stewardId: null,
    participants: [],
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt,
    createdAt: 0,
    updatedAt,
  };
}

function state(sections: {
  inbox?: InteractionView[];
  tasks?: BoardTaskView[];
  conversations?: ConversationSummary[];
}): WireState {
  const target = (list: unknown) => ({
    sections: { list },
    revisions: {},
    version: 1,
  });
  return {
    status: "open",
    ops: [],
    mounted: [],
    targets: {
      ...(sections.inbox ? { inbox: target(sections.inbox) } : {}),
      ...(sections.tasks ? { tasks: target(sections.tasks) } : {}),
      ...(sections.conversations
        ? { conversations: target(sections.conversations) }
        : {}),
    },
    missing: {},
    error: undefined,
  };
}

const withRun = (
  view: BoardTaskView,
  runStatus: BoardTaskView["runStatus"],
): BoardTaskView => ({ ...view, runStatus });

describe("what is waiting", () => {
  it("is empty before the inbox and the board arrive", () => {
    expect(pendingItems(state({}))).toEqual([]);
  });

  it("puts a task that runs before a queued one of its status, whatever their times", () => {
    const s = state({
      tasks: [
        withRun(task("t1", "in_review", 10), "queued"),
        withRun(task("t2", "in_review", 20), "running"),
      ],
    });
    expect(pendingItems(s).map((item) => item.key)).toEqual([
      "task:t2",
      "task:t1",
    ]);
  });
});

describe("the panel's conversations", () => {
  it("are the ones not archived, by their last message, newest first, the update time standing in for none", () => {
    const s = state({
      conversations: [
        conversation("old", 10, 500),
        conversation("quiet", null, 30),
        conversation("new", 50, 1),
        conversation("shelved", 99, 99, true),
      ],
    });
    expect(panelConversations(s).map((c) => c.id)).toEqual([
      "new",
      "quiet",
      "old",
    ]);
  });

  it("are none before the list arrives", () => {
    expect(panelConversations(state({}))).toEqual([]);
  });
});

describe("the open tasks", () => {
  it("are none, and none closed, before the board arrives", () => {
    expect(openTasks(state({}))).toEqual({ open: [], closed: 0 });
  });

  it("put a task that runs before a queued one of its status, even one that moved later", () => {
    const s = state({
      tasks: [
        withRun(task("t1", "in_progress", 10), "running"),
        withRun(task("t2", "in_progress", 30), "queued"),
        withRun(task("t3", "todo", 20), null),
      ],
    });
    expect(openTasks(s).open.map((t) => t.id)).toEqual(["t1", "t3", "t2"]);
  });
});

describe("an item's conversation", () => {
  it("is a task's linked conversation first, then the one it came from", () => {
    const [linked, unlinked] = pendingItems(
      state({
        tasks: [
          task("t1", "blocked", 1, "linked"),
          task("t2", "blocked", 2, null),
        ],
      }),
    );
    const detail = (origin: string | null) =>
      ({ originConversationId: origin }) as BoardTaskDetail;
    expect(itemConversationId(linked!, detail("origin"))).toBe("linked");
    expect(itemConversationId(unlinked!, detail("origin"))).toBe("origin");
    expect(itemConversationId(unlinked!, detail(null))).toBeUndefined();
    expect(itemConversationId(unlinked!)).toBeUndefined();
  });
});

describe("how many wait", () => {
  it("is the number of items waiting, for every question and task status", () => {
    const questions = (
      ["pending", "answered", "canceled", "expired"] as const
    ).map((status, index) => question(`q${index}`, index, status));
    const tasks = (
      [
        "backlog",
        "todo",
        "in_progress",
        "in_review",
        "done",
        "blocked",
        "cancelled",
      ] as const
    ).map((status, index) => task(`t${index + 1}`, status, 100 + index));
    const s = state({ inbox: questions, tasks });
    expect(pendingCount(s)).toBe(3);
    expect(pendingCount(s)).toBe(pendingItems(s).length);
  });
});
