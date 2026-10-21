import type {
  ConversationSummary,
  MessageView,
  SendResult,
} from "@eta/client-contracts";
import type { FakeHost } from "@/test-wire";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { plainDraft } from "@/lib/composer";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import {
  agentView,
  conversationSections,
  conversationView,
  memberView,
  messageView,
  productHost,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";

// A message that every lane was too busy to take waits above the composer, not in the transcript.
// What it must not leave behind is a turn with nothing in it: the host keeps the message out of its
// window, but the reply rows queued under it arrive with the window (and with the `send` answer),
// so the page is the one that has to hold the whole thing back until a lane takes it.

const AGENT = "a1";
const OTHER = "a2";
let conversations = 0;
let CONV = "";
let seq = 0;
let host: FakeHost;
let summary: ConversationSummary;
// What the host answers a send with; a test that wants the message taken instead swaps it.
let answer: (args: Record<string, unknown>) => SendResult;
const sends: Record<string, unknown>[] = [];

const row = (fields: Partial<MessageView>): MessageView => {
  seq += 1;
  return messageView({
    id: `${CONV}-${seq}`,
    conversationId: CONV,
    seq,
    ...fields,
  });
};

/** The user's row, as the host writes it for a message no lane could take. */
const heldRow = ({
  id,
  text,
  data = {},
  ...fields
}: Partial<MessageView> & {
  id: string;
  text: string;
}): MessageView =>
  row({
    ...fields,
    id,
    text,
    rootMessageId: id,
    data: { held: true, woke: [AGENT], joined: [], ...data },
  });

/** The reply the host queued for a message, held or not: it waits under the row it answers. */
const waitingReply = (
  to: MessageView,
  agentId = AGENT,
  fields: Partial<MessageView> = {},
): MessageView =>
  row({
    author: "agent",
    agentId,
    status: "queued",
    replyToId: to.id,
    rootMessageId: to.rootMessageId ?? to.id,
    ...fields,
  });

function start(seed: { rows?: MessageView[]; held?: MessageView[] } = {}) {
  summary = conversationView({
    id: CONV,
    name: "研究员",
    participants: [
      memberView(AGENT, { sessionId: "s1" }),
      memberView(OTHER, { sessionId: "s2" }),
    ],
  });
  host = productHost({
    agents: [
      agentView({ id: AGENT, name: "研究员" }),
      agentView({ id: OTHER, name: "装配" }),
    ],
    conversations: [summary],
    messages: { [CONV]: seed.rows ?? [] },
    held: { [CONV]: seed.held ?? [] },
  });
  host.handle("conversations.send", (args) => {
    const one = args as Record<string, unknown>;
    sends.push(one);
    return answer(one);
  });
  host.handle("conversations.recall", () => ({
    conversationId: CONV,
    recalled: true,
  }));
  host.handle("conversations.stop", () => ({ stopped: [] }));
  host.handle("conversations.attach", (args) => {
    const chunk = args as Record<string, unknown>;
    return {
      attachment: chunk.last
        ? {
            id: chunk.uploadId,
            name: chunk.name,
            contentType: chunk.contentType,
            size: 3,
          }
        : null,
    };
  });
  host.handle("conversations.unattach", () => ({ removed: true }));
  return mount(<Chat conversationId={CONV} />).then((mounted) => ({
    ...mounted,
    host,
  }));
}

/** Replace the conversation's rows, as the host does when a send is answered or a lane frees up. */
const push = async (rows: MessageView[], held: MessageView[] = []) =>
  act(async () =>
    host.set(
      `conversations.${CONV}`,
      conversationSections(summary, rows, {}, held),
    ),
  );

const editor = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[contenteditable]")!;
const composed = (c: HTMLElement) => editor(c).textContent;
const type = (value: string) =>
  act(async () => useOutbox.getState().setDraft(CONV, plainDraft(value)));
async function enter(c: HTMLElement) {
  await act(async () => {
    editor(c).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush();
}
/** The turns the transcript draws, in order. */
const onScreen = (c: HTMLElement) =>
  [...c.querySelectorAll("[data-mid]")].map((el) =>
    el.getAttribute("data-mid"),
  );
const chips = (c: HTMLElement) => [
  ...c.querySelectorAll("[data-slot=held-chip]"),
];
const log = (c: HTMLElement) => c.querySelector('[role="log"]')!.textContent!;
const count = (text: string, part: string) => text.split(part).length - 1;

beforeEach(() => {
  conversations += 1;
  CONV = `held-transcript-${conversations}`;
  seq = 0;
  sends.length = 0;
  answer = (args) => {
    const message = heldRow({
      id: String(args.clientId),
      text: String(args.text),
    });
    return {
      message,
      replies: [waitingReply(message)],
      joined: [],
      nobody: false,
    };
  };
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe("排队的消息不上聊天区的屏", () => {
  it("发送的当场：回复行不画，输入框上方恰好一条 chip", async () => {
    const { container: c } = await start();
    await type("再写个摘要");
    await enter(c);
    expect(sends).toHaveLength(1);
    // The host publishes the window without the message, with the reply it queued inside it.
    const sent = answer(sends[0]!);
    await push([sent.replies[0]!], [sent.message]);
    await flush();
    expect(onScreen(c)).toEqual([]);
    expect(log(c)).not.toContain("再写个摘要");
    expect(chips(c)).toHaveLength(1);
    expect(chips(c)[0]?.textContent).toContain("再写个摘要");
  });

  it("重新加载：窗口里带着那条排队消息的回复行，聊天区仍然不画", async () => {
    const message = heldRow({ id: "held-1", text: "再写个摘要" });
    const reply = waitingReply(message);
    const { container: c } = await start({ rows: [reply], held: [message] });
    await flush();
    expect(onScreen(c)).toEqual([]);
    expect(chips(c)).toHaveLength(1);
  });

  it("带附件的排队消息也一样：只有 chip，聊天区没有空轮", async () => {
    const message = heldRow({
      id: "held-file",
      text: "看看这份",
      data: {
        held: true,
        woke: [AGENT],
        joined: [],
        attachments: [
          { id: "f1", name: "notes.txt", contentType: "text/plain", size: 3 },
        ],
      },
    });
    const { container: c } = await start({
      rows: [waitingReply(message)],
      held: [message],
    });
    await flush();
    expect(onScreen(c)).toEqual([]);
    expect(chips(c)).toHaveLength(1);
  });

  it("两条排队的消息各一条 chip，聊天区一条都不画", async () => {
    const first = heldRow({ id: "held-a", text: "第一句" });
    const second = heldRow({ id: "held-b", text: "第二句" });
    const { container: c } = await start({
      rows: [waitingReply(first), waitingReply(second, OTHER)],
      held: [first, second],
    });
    await flush();
    expect(onScreen(c)).toEqual([]);
    expect(chips(c)).toHaveLength(2);
  });
});

describe("一条道接手了", () => {
  it("chip 消失，这一轮上屏且只上一次", async () => {
    const message = heldRow({ id: "held-1", text: "再写个摘要" });
    const reply = waitingReply(message);
    const { container: c } = await start({ rows: [reply], held: [message] });
    await flush();
    expect(onScreen(c)).toEqual([]);

    await push([message, { ...reply, status: "done", text: "好的" }]);
    expect(onScreen(c)).toEqual([message.id, reply.id]);
    expect(count(log(c), "再写个摘要")).toBe(1);
    expect(chips(c)).toHaveLength(0);
  });

  it("拉回：消息和等它的回复都不留一行，文字回到输入框", async () => {
    const message = heldRow({ id: "held-1", text: "再写个摘要" });
    const { container: c } = await start({
      rows: [waitingReply(message)],
      held: [message],
    });
    await flush();
    await click(c.querySelector("button[aria-label^='拉回输入框']"));
    await flush();
    expect(host.calls.find((call) => call.action === "recall")?.args).toEqual({
      conversationId: CONV,
      messageId: "held-1",
    });
    await push([]);
    expect(onScreen(c)).toEqual([]);
    expect(chips(c)).toHaveLength(0);
    expect(composed(c)).toBe("再写个摘要");
  });

  it("已经上屏的消息，排在它后面的等待行照旧在", async () => {
    const message = row({ text: "做点事", rootMessageId: "on-screen" });
    const running = waitingReply(message, AGENT, { status: "working" });
    const waiting = waitingReply(message, OTHER);
    // A second message waits for a lane of its own; its reply must not show, these two must.
    const held = heldRow({ id: "held-1", text: "再写个摘要" });
    const { container: c } = await start({
      rows: [message, running, waiting, waitingReply(held)],
      held: [held],
    });
    await flush();
    expect(onScreen(c)).toEqual([message.id, running.id, waiting.id]);
    expect(chips(c)).toHaveLength(1);
  });
});
