import type { MessageView } from "@eta/client-contracts";
import { expect, test } from "nsh/test";
import { indexInserts } from "../src/pages/chat/insert-message";

const system = (id: string, data: Record<string, unknown>): MessageView => ({
  id,
  conversationId: "c1",
  seq: 1,
  kind: "message",
  author: "system",
  agentId: null,
  text: "notice",
  thinking: "",
  status: "done",
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data,
  createdAt: 0,
  updatedAt: 0,
});

test("a task draft decision row is not shown, other system rows are", () => {
  const { rows } = indexInserts([
    system("decided", { event: "task_draft_decided" }),
    system("steward", { event: "steward_changed" }),
    system("plain", {}),
  ]);
  expect(rows.map((row) => row.id)).toEqual(["steward", "plain"]);
});
