import type { MessageView } from "@eta/client-contracts";
import { expect, test } from "nsh/test";
import { indexInserts } from "../src/pages/chat/insert-message";

const msg = (id: string, fields: Partial<MessageView> = {}): MessageView => ({
  id,
  conversationId: "c1",
  seq: 1,
  kind: "message",
  author: "user",
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

const system = (id: string, data: Record<string, unknown>): MessageView =>
  msg(id, { author: "system", text: "notice", data });

test("a task draft decision row is not shown, other system rows are", () => {
  const { rows } = indexInserts([
    system("decided", { event: "task_draft_decided" }),
    system("steward", { event: "steward_changed" }),
    system("plain", {}),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["steward", "plain"]);
});

test("user prompt folds data.into inserts and maps active reply recipients", () => {
  const u1 = msg("u1", { seq: 1, text: "hello" });
  const r1 = msg("r1", {
    seq: 2,
    author: "agent",
    agentId: "Ada",
    status: "working",
    replyToId: "u1",
    rootMessageId: "u1",
  });
  const u2 = msg("u2", { seq: 3, text: "also this", data: { into: "u1" } });

  const { rows, additions, recipients } = indexInserts([u1, r1, u2]);
  expect(rows.map((r) => r.id)).toEqual(["u1", "r1"]);
  expect(additions.get("u1")?.map((r) => r.id)).toEqual(["u2"]);
  expect(recipients.get("u1")).toEqual(["Ada"]);
});

test("@mention chain maps active reply recipients onto the root prompt", () => {
  const u1 = msg("u1", { seq: 1, text: "plan it" });
  const r1 = msg("r1", {
    seq: 2,
    author: "agent",
    agentId: "Ada",
    status: "done",
    replyToId: "u1",
    rootMessageId: "u1",
  });
  const m1 = msg("m1", {
    seq: 3,
    kind: "mention",
    author: "agent",
    agentId: "Ada",
    text: "Bob check this",
    replyToId: "r1",
    rootMessageId: "u1",
  });
  const r2 = msg("r2", {
    seq: 4,
    author: "agent",
    agentId: "Bob",
    status: "working",
    replyToId: "m1",
    rootMessageId: "u1",
  });

  const { recipients } = indexInserts([u1, r1, m1, r2]);
  expect(recipients.get("u1")).toEqual(["Bob"]);
  expect(recipients.has("m1")).toBe(false);
});

test("Captain review row anchors active reply recipients and folds data.into inserts", () => {
  const review = msg("rev1", {
    seq: 1,
    author: "system",
    text: "<captain-review>\n1. [task_stalled] stalled\n</captain-review>",
    data: { captainReview: { reviewIds: ["r-1"] } },
  });
  const reply = msg("cap1", {
    seq: 2,
    author: "agent",
    agentId: "Captain",
    status: "working",
    replyToId: "rev1",
    rootMessageId: "rev1",
  });
  const steer = msg("u1", {
    seq: 3,
    text: "focus on #7",
    data: { into: "rev1" },
  });

  const { rows, additions, recipients } = indexInserts([review, reply, steer]);
  expect(rows.map((r) => r.id)).toEqual(["rev1", "cap1"]);
  expect(additions.get("rev1")?.map((r) => r.id)).toEqual(["u1"]);
  expect(recipients.get("rev1")).toEqual(["Captain"]);
});

test("captain_proposal anchors captainOutcome reply recipients and folds data.into inserts", () => {
  const proposal = msg("prop1", {
    seq: 1,
    kind: "system",
    author: "system",
    data: {
      event: "captain_proposal",
      kind: "create_group",
      operationId: "op-1",
      proposal: { name: "Launch" },
    },
  });
  const outcome = msg("out1", {
    seq: 2,
    author: "system",
    text: "confirmed",
    data: {
      captainOutcome: {
        operationId: "op-1",
        kind: "create_group",
        status: "applied",
      },
    },
  });
  const reply = msg("cap1", {
    seq: 3,
    author: "agent",
    agentId: "Captain",
    status: "working",
    replyToId: "out1",
    rootMessageId: "out1",
  });
  const steer = msg("u1", {
    seq: 4,
    text: "adjust goal",
    data: { into: "prop1" },
  });

  const { rows, additions, recipients } = indexInserts([
    proposal,
    outcome,
    reply,
    steer,
  ]);
  expect(rows.map((r) => r.id)).toEqual(["prop1", "out1", "cap1"]);
  expect(additions.get("prop1")?.map((r) => r.id)).toEqual(["u1"]);
  expect(recipients.get("prop1")).toEqual(["Captain"]);
  expect(recipients.has("out1")).toBe(false);
});

test("captainOutcome without matching proposal or already stripped falls back to reply.id", () => {
  const outcome = msg("out1", {
    seq: 1,
    author: "system",
    text: "rejected",
    data: {
      captainOutcome: {
        operationId: "op-missing",
        kind: "create_group",
        status: "rejected",
      },
    },
  });
  const reply = msg("cap1", {
    seq: 2,
    author: "agent",
    agentId: "Captain",
    status: "working",
    replyToId: "out1",
    rootMessageId: "out1",
  });

  expect(indexInserts([outcome, reply]).recipients.get("cap1")).toEqual([
    "Captain",
  ]);
  expect(indexInserts([reply]).recipients.get("cap1")).toEqual(["Captain"]);
});

test("unsolicited reply anchors recipients and retains data.into additions after done", () => {
  const workingReply = msg("r1", {
    seq: 1,
    author: "agent",
    agentId: "Ada",
    status: "working",
  });
  const steer = msg("u1", {
    seq: 2,
    text: "good catch",
    data: { into: "r1" },
  });

  const live = indexInserts([workingReply, steer]);
  expect(live.recipients.get("r1")).toEqual(["Ada"]);
  expect(live.additions.get("r1")?.map((r) => r.id)).toEqual(["u1"]);

  const finished = indexInserts([{ ...workingReply, status: "done" }, steer]);
  expect(finished.recipients.has("r1")).toBe(false);
  expect(finished.additions.get("r1")?.map((r) => r.id)).toEqual(["u1"]);
});

test("partial-join chained insert resolves recipients and additions to the root anchor", () => {
  const u1 = msg("u1", { seq: 1, text: "start" });
  const u2 = msg("u2", { seq: 2, text: "also", data: { into: "u1" } });
  const r2 = msg("r2", {
    seq: 3,
    author: "agent",
    agentId: "Ada",
    status: "working",
    replyToId: "u2",
    rootMessageId: "u2",
  });

  const { rows, additions, recipients } = indexInserts([u1, u2, r2]);
  expect(rows.map((r) => r.id)).toEqual(["u1", "r2"]);
  expect(additions.get("u1")?.map((r) => r.id)).toEqual(["u2"]);
  expect(recipients.get("u1")).toEqual(["Ada"]);
});
