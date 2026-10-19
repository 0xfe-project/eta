import type { MessageView, SendResult } from "@eta/client-contracts";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { plainDraft } from "@/lib/composer";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { Chat } from "@/test-chat";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
  productHost,
} from "@/test-product";
import { button, cleanup, click, flush, mount } from "@/test-render";

const AGENT = "a1";
let conversations = 0;
let CONV = "";
let seq = 0;

interface Pending {
  args: Record<string, unknown>;
  resolve: (result: SendResult) => void;
  reject: (error: Error) => void;
}
let sends: Pending[] = [];
// The projects the composer asked for files of.
let filesAsked: string[] = [];
// The upload chunks the host got, and a gate to hold the last one.
let chunks: Record<string, unknown>[] = [];
let uploadGate: Promise<void> | undefined;

const row = (fields: Partial<MessageView>): MessageView => {
  seq += 1;
  return messageView({
    id: `${CONV}-${seq}`,
    conversationId: CONV,
    seq,
    ...fields,
  });
};

/** What the host answers a send with: the user's row, and a queued reply from the agent. */
const accepted = (args: Record<string, unknown>): SendResult => {
  const message = row({ id: String(args.clientId), text: String(args.text) });
  return {
    message,
    replies: [
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: message.id,
        status: "queued",
      }),
    ],
    joined: [],
    nobody: false,
  };
};

function start(
  messages: MessageView[] = [],
  members = [memberView(AGENT, { sessionId: "s1" })],
) {
  const summary = conversationView({
    id: CONV,
    name: "研究员",
    participants: members,
  });
  const host = productHost({
    agents: [agentView({ id: AGENT, name: "研究员" })],
    conversations: [summary],
    messages: { [CONV]: messages },
  });
  // A send waits for the test to answer it, as a slow host would.
  host.handle(
    "conversations.send",
    (args) =>
      new Promise<SendResult>((resolve, reject) =>
        sends.push({ args: args as Record<string, unknown>, resolve, reject }),
      ),
  );
  host.handle("conversations.stop", () => ({ stopped: [] }));
  host.handle("conversations.attach", async (args) => {
    const chunk = args as Record<string, unknown>;
    chunks.push(chunk);
    await uploadGate;
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
  host.handle("projects.files", (args) => {
    filesAsked.push((args as { projectId: string }).projectId);
    return {
      files: ["README.md", "src/app.ts", "src/lib/util.ts"],
      truncated: false,
    };
  });
  return mount(<Chat conversationId={CONV} />).then((mounted) => ({
    ...mounted,
    host,
  }));
}

const editor = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[contenteditable]")!;
const composed = (c: HTMLElement) => editor(c).textContent;
// Typing goes through the draft: the composer shows what the draft holds.
const type = (value: string) =>
  act(async () => useOutbox.getState().setDraft(CONV, plainDraft(value)));
async function enter(c: HTMLElement, init: KeyboardEventInit = {}) {
  await act(async () => {
    editor(c).dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
  await flush();
}
const log = (c: HTMLElement) => c.querySelector('[role="log"]')!.textContent!;
const count = (text: string, part: string) => text.split(part).length - 1;

beforeEach(() => {
  conversations += 1;
  CONV = `chat-delivery-${conversations}`;
  seq = 0;
  sends = [];
  filesAsked = [];
  chunks = [];
  uploadGate = undefined;
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
});
afterEach(async () => {
  rstest.useRealTimers();
  // Ends the deliveries still waiting, so none outlives its test.
  useOutbox.setState({ outgoing: [] });
  for (const send of sends) send.reject(new Error("done"));
  await flush();
  await cleanup();
  setWire(undefined);
});

describe("sending a message", () => {
  it("shows it at once and sends it once, however often Enter is pressed", async () => {
    const { container: c } = await start();
    await type("你好");
    await enter(c);
    await enter(c);
    await enter(c);
    expect(sends).toHaveLength(1);
    expect(composed(c)).toBe("");
    expect(log(c)).toContain("你好");
    expect(log(c)).toContain("发送中");
    // The row's id is the message's id: a retry is the same message, never a second one.
    expect(sends[0]!.args.clientId).toEqual(expect.any(String));
    expect(sends[0]!.args).toMatchObject({
      conversationId: CONV,
      text: "你好",
      mode: "queue",
      mentions: [],
    });

    await act(async () => sends[0]!.resolve(accepted(sends[0]!.args)));
    await flush();
    expect(count(log(c), "你好")).toBe(1);
    expect(log(c)).not.toContain("发送中");
  });

  it("shows the reply row the host started, as soon as the send is answered", async () => {
    const { container: c } = await start();
    await type("你好");
    await enter(c);
    const result = accepted(sends[0]!.args);
    await act(async () => sends[0]!.resolve(result));
    await flush();
    // The queued reply is an empty row under the message, before any push of the timeline.
    const rows = c.querySelectorAll("[data-mid]");
    expect([...rows].map((r) => r.getAttribute("data-mid"))).toEqual([
      result.message.id,
      result.replies[0]!.id,
    ]);
  });

  it("names who it is for by @, and leaves a bare message to the host", async () => {
    const { container: c } = await start();
    await type("@研究员 看一下");
    await enter(c);
    expect(sends[0]!.args.mentions).toEqual([AGENT]);
    // One conversation's messages go out one at a time.
    await act(async () => sends[0]!.resolve(accepted(sends[0]!.args)));
    await flush();
    await type("没人叫");
    await enter(c);
    expect(sends[1]!.args.mentions).toEqual([]);
  });

  it("leaves the next draft alone when the last message arrives", async () => {
    const { container: c } = await start();
    await type("第一条");
    await enter(c);
    await type("正在写第二条");
    await act(async () => sends[0]!.resolve(accepted(sends[0]!.args)));
    await flush();
    expect(composed(c)).toBe("正在写第二条");
  });

  it("does not retry what the host refused, and can edit it", async () => {
    const { container: c } = await start();
    await type("你好");
    await enter(c);
    await act(async () =>
      sends[0]!.reject(new Error("该智能体待处理的消息过多。")),
    );
    await flush();
    expect(sends).toHaveLength(1);
    expect(log(c)).toContain("该智能体待处理的消息过多。");
    await click(button(c, "编辑"));
    expect(composed(c)).toBe("你好");
    expect(log(c)).not.toContain("你好");
  });

  it("tries again as the same message when the connection drops, then offers a retry", async () => {
    const { container: c, host } = await start();
    await type("你好");
    await enter(c);
    // The waits between tries pass at once.
    rstest.useFakeTimers({ toFake: ["setTimeout"] });
    await act(async () => {
      host.socket.drop();
      await rstest.advanceTimersByTimeAsync(20_000);
    });
    expect(log(c)).toContain("网络连接失败，消息未送达。");
    expect(sends).toHaveLength(1);
    const firstId = sends[0]!.args.clientId;
    sends = [];

    // Back on a connection, the retry is the same message.
    rstest.useRealTimers();
    await act(async () => host.hello());
    await click(button(c, "重试"));
    await flush();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args.clientId).toBe(firstId);
    await act(async () => sends[0]!.resolve(accepted(sends[0]!.args)));
    await flush();
    expect(count(log(c), "你好")).toBe(1);
  });
});

describe("steering and stopping", () => {
  const working = () => [
    row({ text: "做点事" }),
    row({
      author: "agent",
      agentId: AGENT,
      status: "working",
    }),
  ];

  it("sends into the turn in flight with ⌘Enter", async () => {
    const { container: c } = await start(working());
    await type("改个方向");
    await enter(c, { metaKey: true });
    expect(sends[0]!.args).toMatchObject({ text: "改个方向", mode: "queue" });
  });

  it("steers with /steer", async () => {
    const { container: c } = await start(working());
    await type("/steer 改个方向");
    await enter(c);
    expect(sends[0]!.args).toMatchObject({ text: "改个方向", mode: "steer" });
  });

  it("stops the reply that is running when Enter is pressed on an empty box", async () => {
    const messages = working();
    const { container: c, host } = await start(messages);
    expect(button(c, "停止")).toBeDefined();
    await enter(c);
    expect(host.calls.find((call) => call.action === "stop")?.args).toEqual({
      conversationId: CONV,
      messageId: messages[1]!.id,
    });
  });

  it("stops every reply with /stop", async () => {
    const { container: c, host } = await start(working());
    await type("/stop");
    await enter(c);
    expect(host.calls.find((call) => call.action === "stop")?.args).toEqual({
      conversationId: CONV,
    });
  });
});

describe("waiting replies", () => {
  it("says nothing about a reply that is waiting its turn", async () => {
    const user = row({ text: "问题" });
    const { container: c } = await start([
      user,
      row({
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        status: "queued",
      }),
    ]);
    expect(log(c)).not.toContain("排队");
    expect(log(c)).not.toContain("等待");
  });
});

describe("older rows", () => {
  it("offers the earlier page while the oldest row seen is not the first", async () => {
    const { container: c } = await start([row({ text: "第三条", seq: 3 })]);
    expect(c.textContent).toContain("加载更早的消息");
  });
});

describe("the @ menu", () => {
  const options = (c: HTMLElement) =>
    [...c.querySelectorAll('[role="option"]')].map((o) => o.textContent);

  it("offers the members first and then the project's files, listed on demand", async () => {
    const { container: c } = await start();
    await flush();
    // Nothing is asked of the project's machine until an @ is typed.
    expect(filesAsked).toEqual([]);
    await type("看一下 @");
    await flush();
    expect(filesAsked).toEqual(["p1"]);
    const rows = options(c);
    expect(rows[0]).toContain("@研究员");
    expect(rows.slice(1).map((row) => row?.split("文件")[0])).toEqual([
      "@README.md",
      "@src/app.ts",
      "@src/lib/util.ts",
    ]);
  });

  it("narrows the files as the person types, and completes the path", async () => {
    const { container: c } = await start();
    await type("看 @util");
    await flush();
    expect(options(c)).toEqual([expect.stringContaining("@src/lib/util.ts")]);
    await enter(c);
    expect(composed(c)).toBe("看 @src/lib/util.ts ");
  });
});

describe("attaching files", () => {
  const pick = async (c: HTMLElement, ...files: File[]) => {
    const input = c.querySelector<HTMLInputElement>(
      '[data-testid="composer-pick"]',
    )!;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush(20);
  };
  const note = () => new File(["abc"], "notes.txt", { type: "text/plain" });

  it("uploads a picked file at once and sends it with the message", async () => {
    const { container: c } = await start();
    await pick(c, note());
    expect(c.textContent).toContain("[notes.txt · 3 B]");
    expect(chunks).toHaveLength(1);
    expect(useOutbox.getState().drafts[CONV]).toMatchObject([
      { type: "file", name: "notes.txt", contentType: "text/plain", size: 3 },
    ]);
  });

  it("sends the attachment ids with the message, and clears the draft", async () => {
    const { container: c } = await start();
    await pick(c, note());
    const block = useOutbox
      .getState()
      .drafts[CONV]!.find((part) => part.type === "file")!;
    await act(async () =>
      useOutbox
        .getState()
        .setDraft(CONV, [{ type: "text", text: "看看" }, block]),
    );
    await enter(c);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args).toMatchObject({
      text: "看看",
      attachments: [block.id],
    });
    expect(useOutbox.getState().drafts[CONV]).toBeUndefined();
    // On its way, the message shows its file.
    expect(c.querySelector('[role="log"]')!.textContent).toContain(
      "[notes.txt · 3 B]",
    );
  });

  it("can send a file with no words", async () => {
    const { container: c } = await start();
    await pick(c, note());
    await enter(c);
    expect(sends[0]!.args).toMatchObject({ text: "" });
    expect((sends[0]!.args.attachments as string[]).length).toBe(1);
  });

  it("waits for an upload that is not done, and says so", async () => {
    let release!: () => void;
    uploadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { container: c } = await start();
    await pick(c, note());
    const block = useOutbox.getState().drafts[CONV]![0]!;
    await act(async () =>
      useOutbox
        .getState()
        .setDraft(CONV, [{ type: "text", text: "好了吗" }, block]),
    );
    await enter(c);
    expect(sends).toHaveLength(0);
    expect(c.textContent).toContain("附件上传中，完成后才能发送");
    await act(async () => release());
    await flush(20);
    await enter(c);
    expect(sends).toHaveLength(1);
  });

  it("takes a removed file back from the host", async () => {
    const { container: c, host } = await start();
    await pick(c, note());
    await click(c.querySelector('button[aria-label*="notes.txt"]'));
    await flush(20);
    expect(host.calls.at(-1)).toMatchObject({
      action: "unattach",
      args: { conversationId: CONV },
    });
    expect(c.textContent).not.toContain("[notes.txt");
  });
});
