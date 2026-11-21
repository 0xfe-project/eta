import type { MessageView } from "@eta/client-contracts";
import { expect, test } from "nsh/test";
import { withoutHeldReplies } from "../src/pages/chat/held-rows";

let seq = 0;
function row(fields: Partial<MessageView> & { id: string }): MessageView {
  seq += 1;
  return {
    conversationId: "group",
    seq,
    kind: "message",
    author: "user",
    agentId: null,
    text: "",
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: fields.id,
    replyToId: null,
    data: {},
    createdAt: seq,
    updatedAt: seq,
    ...fields,
  };
}

const reply = (id: string, to: MessageView, status: MessageView["status"]) =>
  row({
    id,
    author: "agent",
    agentId: "atlas",
    status,
    rootMessageId: to.rootMessageId,
    replyToId: to.id,
  });

test("three messages sent while Atlas replies leave one reply in the list, and the rest in the held list", () => {
  const first = row({ id: "u0" });
  const running = reply("r0", first, "working");
  // The host keeps the held messages out of its window, but not the replies queued under them.
  const held = ["u1", "u2", "u3"].map((id) =>
    row({ id, data: { held: true, woke: ["atlas"], joined: [] } }),
  );
  const waiting = held.map((message, index) =>
    reply(`r${index + 1}`, message, "queued"),
  );
  const window = [first, running, ...waiting];

  const shown = withoutHeldReplies(window, held);
  expect(shown.map((message) => message.id)).toEqual(["u0", "r0"]);
  // Nothing is lost: each message is in the held list, which the composer draws.
  expect(held.map((message) => message.id)).toEqual(["u1", "u2", "u3"]);
});

test("a queued reply under a message already in the list stays, and everything stays when nothing is held", () => {
  const first = row({ id: "u0" });
  const second = row({ id: "u1" });
  const window = [
    first,
    reply("r0", first, "working"),
    second,
    reply("r1", second, "queued"),
  ];
  expect(withoutHeldReplies(window, [])).toBe(window);
  const held = [row({ id: "u2", data: { held: true } })];
  expect(withoutHeldReplies(window, held).map((message) => message.id)).toEqual(
    ["u0", "r0", "u1", "r1"],
  );
});

test("the held message itself is never dropped from what it is given", () => {
  const held = row({ id: "u1", data: { held: true } });
  expect(withoutHeldReplies([held], [held])).toEqual([held]);
});
