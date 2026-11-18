import type {
  MessageView,
  SendResult,
  ViewMessageRow,
} from "@eta/client-contracts";
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plainDraft } from "@/lib/composer";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import { surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";

// What the composer and the transcript let you do about replies being written: put more words
// into the turn answering one of your messages (from that message), stop one reply (from its
// process window) or all of them (Esc), and send — the send button is never a stop, and a `/`
// is just a character.

const ADA = "a1";
const BO = "a2";
let conversations = 0;
let CONV = "";

const entry = (seq: number, message: object): ViewMessageRow =>
  ({ entryId: `e${seq}`, seq, at: seq, message }) as ViewMessageRow;
/** A session in the middle of its run: it took a briefing, called a tool, and took a steer. */
const sessionRows = [
  entry(1, { role: "user", content: "查一下", timestamp: 1 }),
  entry(2, {
    role: "assistant",
    timestamp: 2,
    content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
  }),
  entry(3, {
    role: "toolResult",
    toolCallId: "c1",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 3,
  }),
  entry(4, { role: "user", content: "顺便看下 key", timestamp: 4 }),
  entry(5, {
    role: "assistant",
    timestamp: 5,
    content: [{ type: "text", text: "在看 key" }],
  }),
];

interface Opened {
  container: HTMLElement;
  host: ReturnType<typeof surfaceHost>;
  /** The user's earlier message, already answered. */
  earlier: MessageView;
  /** The user's message both agents are answering now. */
  asked: MessageView;
  replies: MessageView[];
  sends: Record<string, unknown>[];
}

/**
 * A group of two where you asked something earlier (answered) and then something both are
 * answering now. `answer` is what the host says to a send.
 */
async function opened(
  answer: (args: Record<string, unknown>) => SendResult,
  writing = true,
): Promise<Opened> {
  conversations += 1;
  CONV = `insert-${conversations}`;
  let seq = 0;
  const row = (fields: Partial<MessageView>) => {
    seq += 1;
    return messageView({
      id: `${CONV}-${seq}`,
      conversationId: CONV,
      seq,
      ...fields,
    });
  };
  const earlier = row({ text: "先问的" });
  const before = row({
    author: "agent",
    agentId: ADA,
    replyToId: earlier.id,
    status: "done",
    text: "答过了",
  });
  const asked = row({ text: "帮我看看为什么一直 401" });
  const status = writing ? "working" : "done";
  const replies = [ADA, BO].map((agentId) =>
    row({
      author: "agent",
      agentId,
      replyToId: asked.id,
      status,
      text: writing ? "" : "看完了",
      data: writing ? { runFrom: 0 } : {},
    }),
  );
  const sends: Record<string, unknown>[] = [];
  const host = surfaceHost({
    agents: [
      agentView({ id: ADA, name: "研究员" }),
      agentView({ id: BO, name: "审稿人" }),
    ],
    conversations: [
      conversationView({
        id: CONV,
        name: "排查",
        participants: [
          memberView(ADA, { sessionId: "s1" }),
          memberView(BO, { sessionId: "s2" }),
        ],
        lastSeq: seq,
      }),
    ],
    messages: { [CONV]: [earlier, before, asked, ...replies] },
  });
  for (const session of ["s1", "s2"])
    host.target(`sessions.${session}`, {
      core: { session, running: writing },
      transcript: { messages: sessionRows },
    });
  host.handle("sessions.resync", () => ({}));
  host.handle("conversations.stop", () => ({ stopped: [] }));
  host.handle("conversations.send", (args) => {
    sends.push(args as Record<string, unknown>);
    return answer(args as Record<string, unknown>);
  });
  const { container } = await mount(<Chat conversationId={CONV} />);
  await flush(20);
  return { container, host, earlier, asked, replies, sends };
}

/** The user row the host writes for a send, with `data` as given. */
const written = (
  args: Record<string, unknown>,
  data: Record<string, unknown>,
): SendResult => ({
  message: messageView({
    id: String(args.clientId),
    conversationId: String(args.conversationId),
    seq: 100,
    text: String(args.text),
    createdAt: Date.UTC(2026, 10, 18, 6, 2),
    data,
  }),
  replies: [],
  joined: data.into === undefined ? [] : [ADA, BO],
  nobody: false,
});

const editor = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[contenteditable]")!;
const type = (value: string) =>
  act(async () => useOutbox.getState().setDraft(CONV, plainDraft(value)));
async function press(c: HTMLElement, key: string) {
  await act(async () => {
    editor(c).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
  await flush();
}
const turn = (c: HTMLElement, id: string) =>
  c.querySelector<HTMLElement>(`[data-mid="${id}"]`)!;
const insertButtons = (c: HTMLElement) =>
  [...c.querySelectorAll("button")].filter(
    (b) => b.textContent === "插入" && b.closest("[data-mid]") !== null,
  );
/** The insert box, once open: it is drawn over the conversation, outside it. */
const insertBox = () =>
  document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="插入这一轮"]',
  );
async function typeInto(box: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enterIn(box: HTMLElement) {
  await act(async () => {
    box.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush(20);
}

beforeEach(() => {
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  useOutbox.setState({ outgoing: [] });
  await cleanup();
  setWire(undefined);
});

describe("inserting into a message being answered", () => {
  it("offers Insert only on the message a reply is being written to", async () => {
    const {
      container: c,
      asked,
      earlier,
    } = await opened((args) => written(args, {}));
    const offered = insertButtons(c);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.closest("[data-mid]")?.getAttribute("data-mid")).toBe(
      asked.id,
    );
    expect(turn(c, earlier.id).textContent).not.toContain("插入");
  });

  it("offers none once the turn is over", async () => {
    const { container: c } = await opened((args) => written(args, {}), false);
    expect(insertButtons(c)).toHaveLength(0);
  });

  it("sends to everyone answering it, and the words join the message, not the transcript", async () => {
    const {
      container: c,
      asked,
      sends,
    } = await opened((args) =>
      written(args, { into: args.into, joined: [ADA, BO], woke: [] }),
    );
    await click(insertButtons(c)[0]);
    const box = insertBox()!;
    // Who it goes to is said before it goes.
    expect(document.body.textContent).toContain("插给 研究员、审稿人");
    await typeInto(box, "顺便看下 key 是不是过期了");
    await enterIn(box);

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      conversationId: CONV,
      text: "顺便看下 key 是不是过期了",
      into: asked.id,
      mode: "steer",
      mentions: [ADA, BO],
    });
    // Closed, and the words are part of the message they were put into.
    expect(insertBox()).toBeNull();
    const message = turn(c, asked.id);
    expect(message.textContent).toContain("帮我看看为什么一直 401");
    expect(message.textContent).toContain("插入 · ");
    expect(message.textContent).toContain("顺便看下 key 是不是过期了");
    // Not a row of its own.
    expect(
      c.querySelector(`[data-mid="${String(sends[0]!.clientId)}"]`),
    ).toBeNull();
  });

  it("keeps the draft when it is closed without sending", async () => {
    const { container: c } = await opened((args) => written(args, {}));
    await click(insertButtons(c)[0]);
    await typeInto(insertBox()!, "还没想好");
    await act(async () => {
      insertBox()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await flush(20);
    expect(insertBox()).toBeNull();
    await click(insertButtons(c)[0]);
    expect(insertBox()!.value).toBe("还没想好");
  });

  it("copies the message with what was inserted into it, in order", async () => {
    const copied = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: copied },
      configurable: true,
    });
    const { container: c, asked } = await opened((args) =>
      written(args, { into: args.into }),
    );
    await click(insertButtons(c)[0]);
    await typeInto(insertBox()!, "补一句");
    await enterIn(insertBox()!);
    await click(button(turn(c, asked.id), "复制"));
    expect(copied).toHaveBeenCalledWith("帮我看看为什么一直 401\n\n补一句");
  });

  it("sends it as a new message, and says so, when the turn ended before it got there", async () => {
    const said = vi.spyOn(toast, "message").mockImplementation(() => 0);
    const {
      container: c,
      asked,
      sends,
    } = await opened((args) => written(args, { woke: [ADA], joined: [] }));
    await click(insertButtons(c)[0]);
    await typeInto(insertBox()!, "晚了一步");
    await enterIn(insertBox()!);
    expect(said).toHaveBeenCalledWith("这一轮已经结束，已作为新消息发出");
    // A message of its own, under the transcript, not inside the one it was meant for.
    expect(turn(c, asked.id).textContent).not.toContain("晚了一步");
    expect(
      c.querySelector(`[data-mid="${String(sends[0]!.clientId)}"]`)
        ?.textContent,
    ).toContain("晚了一步");
  });

  it("marks in the process window where the run took the inserted words", async () => {
    const { container: c, replies } = await opened((args) => written(args, {}));
    const process = turn(c, replies[0]!.id);
    expect(process.textContent).toContain("— 收到你插入的消息 —");
    // The trace sits between what came before it and after it, and does not repeat the words.
    expect(process.textContent).not.toContain("顺便看下 key");
    const text = process.textContent!;
    expect(text.indexOf("收到你插入的消息")).toBeLessThan(
      text.indexOf("在看 key"),
    );
  });
});

describe("stopping", () => {
  it("stops one reply from its own process window, and says it is stopping", async () => {
    const {
      container: c,
      host,
      replies,
    } = await opened((args) => written(args, {}));
    const stops = [...c.querySelectorAll("button")].filter(
      (b) => b.textContent === "停止",
    );
    // Two replies being written, two stops.
    expect(stops).toHaveLength(2);
    await click(button(turn(c, replies[1]!.id), "停止"));
    expect(host.calls.filter((call) => call.action === "stop")).toEqual([
      {
        target: "conversations",
        action: "stop",
        args: { conversationId: CONV, messageId: replies[1]!.id },
      },
    ]);
  });

  it("reads Stopping… while the stop is on its way, and can be pressed again", async () => {
    const {
      container: c,
      host,
      replies,
    } = await opened((args) => written(args, {}));
    await act(async () =>
      host.set(`conversations.${CONV}`, {
        timeline: {
          messages: [{ ...replies[0]!, status: "stopping", revision: 2 }],
          hasMore: false,
          held: [],
        },
      }),
    );
    await flush(20);
    const stopping = button(turn(c, replies[0]!.id), "停止中…");
    expect(stopping).toBeDefined();
    await click(stopping);
    expect(
      host.calls.filter((call) => call.action === "stop").map((x) => x.args),
    ).toEqual([{ conversationId: CONV, messageId: replies[0]!.id }]);
  });

  it("keeps the send button a send button, and an empty Enter stops nothing", async () => {
    const { container: c, host } = await opened((args) => written(args, {}));
    const submit = c.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.textContent).toBe("发送");
    await press(c, "Enter");
    expect(host.calls.some((call) => call.action === "stop")).toBe(false);
  });

  it("stops every reply with Esc in an empty box, and not with words in it", async () => {
    const { container: c, host } = await opened((args) => written(args, {}));
    await type("还在写");
    await press(c, "Escape");
    expect(host.calls.some((call) => call.action === "stop")).toBe(false);
    await type("");
    await press(c, "Escape");
    expect(
      host.calls.filter((call) => call.action === "stop").map((x) => x.args),
    ).toEqual([{ conversationId: CONV }]);
  });
});

describe("the composer", () => {
  it("opens no menu for a slash, and sends it as words", async () => {
    const { container: c, sends } = await opened((args) => written(args, {}));
    await type("/stop");
    await flush();
    expect(c.querySelectorAll('[role="option"]')).toHaveLength(0);
    await press(c, "Enter");
    await flush(20);
    expect(sends[0]).toMatchObject({ text: "/stop", mode: "queue" });
    expect(sends[0]).not.toHaveProperty("into");
  });

  it("sends a message to someone busy as a new message, for the host to queue", async () => {
    const { container: c, sends } = await opened((args) =>
      written(args, { held: true, woke: [ADA], joined: [] }),
    );
    await type("@研究员 接着做下一步");
    await press(c, "Enter");
    await flush(20);
    expect(sends[0]).toMatchObject({ mode: "queue", mentions: [ADA] });
  });
});
