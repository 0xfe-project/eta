// A widget's `sendPrompt` puts text in the message box and nothing more: the message goes only when
// the user sends it. Its scripts run with no click behind them, and again every time the
// conversation is opened, so a widget that could send would speak for the user.
import type { MessageView, SendResult } from "@eta/client-contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { draftText, plainDraft } from "@/lib/composer";
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
import { cleanup, flush, mount } from "@/test-render";
import { WIDGET_MESSAGE, WIDGET_SHELL } from "./widget-shell";

const AGENT = "a1";
let conversations = 0;
let CONV = "";
let seq = 0;
let sends: Record<string, unknown>[] = [];

const row = (fields: Partial<MessageView>): MessageView => {
  seq += 1;
  return messageView({
    id: `${CONV}-${seq}`,
    conversationId: CONV,
    seq,
    ...fields,
  });
};

/** A finished reply that drew a widget with a button calling `sendPrompt`. */
function history() {
  const user = row({ text: "构建情况" });
  const reply = row({
    author: "agent",
    agentId: AGENT,
    replyToId: user.id,
    status: "done",
    text: "如上",
    data: {
      activity: [
        {
          id: "w1",
          name: "show_widget",
          input: { title: "构建" },
          status: "completed",
          details: {
            title: "构建",
            widget_code:
              "<button onclick=\"sendPrompt('拆开最慢的一步')\">拆开</button>",
          },
        },
      ],
    },
  });
  return [user, reply];
}

async function start(messages: MessageView[]) {
  const host = productHost({
    agents: [agentView({ id: AGENT, name: "研究员" })],
    conversations: [
      conversationView({
        id: CONV,
        name: "研究员",
        participants: [memberView(AGENT, { sessionId: "s1" })],
      }),
    ],
    messages: { [CONV]: messages },
  });
  host.handle("conversations.send", (args) => {
    const sent = args as Record<string, unknown>;
    sends.push(sent);
    const message = row({ id: String(sent.clientId), text: String(sent.text) });
    return { message, replies: [], joined: [], nobody: false } as SendResult;
  });
  const mounted = await mount(<Chat conversationId={CONV} />);
  await flush();
  return { ...mounted, host };
}

/** What the widget's frame posts when a script in it calls `sendPrompt(text)`. */
async function widgetCalls(c: HTMLElement, text: string) {
  const frame = c.querySelector<HTMLIFrameElement>(".turn-tasks iframe")!;
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: WIDGET_MESSAGE, kind: "draft", text },
        source: frame.contentWindow,
      }),
    );
  });
  await flush();
}

const editor = (c: HTMLElement) =>
  c.querySelector<HTMLElement>("[contenteditable]")!;
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

beforeEach(() => {
  conversations += 1;
  CONV = `widget-draft-${conversations}`;
  seq = 0;
  sends = [];
  useOutbox.setState({ drafts: {}, uploads: {}, outgoing: [] });
});
afterEach(async () => {
  useOutbox.setState({ outgoing: [] });
  await cleanup();
  setWire(undefined);
});

describe("a widget's sendPrompt", () => {
  it("is a draft message, not a send, in the shell the frame runs", () => {
    expect(WIDGET_SHELL).toContain(
      'window.sendPrompt = (text) => post({ kind: "draft", text: String(text) });',
    );
    expect(WIDGET_SHELL).not.toContain('kind: "prompt"');
  });

  it("fills the box, and only the user's own Enter sends it", async () => {
    const { container: c, host } = await start(history());
    await widgetCalls(c, "拆开最慢的一步");

    expect(editor(c).textContent).toBe("拆开最慢的一步");
    expect(sends).toHaveLength(0);
    expect(host.calls.some((call) => call.action === "send")).toBe(false);
    expect(useOutbox.getState().outgoing).toHaveLength(0);

    await enter(c);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      conversationId: CONV,
      text: "拆开最慢的一步",
      mode: "queue",
    });
    expect(editor(c).textContent).toBe("");
  });

  it("keeps what the user was writing, below the widget's text", async () => {
    const { container: c } = await start(history());
    await act(async () =>
      useOutbox.getState().setDraft(CONV, plainDraft("我自己的话")),
    );
    await widgetCalls(c, "拆开最慢的一步");
    expect(draftText(useOutbox.getState().drafts[CONV] ?? [])).toBe(
      "拆开最慢的一步\n\n我自己的话",
    );
    expect(sends).toHaveLength(0);
  });

  it("sends nothing when the conversation is opened again and its scripts run again", async () => {
    const messages = history();
    const first = await start(messages);
    await widgetCalls(first.container, "拆开最慢的一步");
    await cleanup();
    // Opened again: the widget is drawn anew and a script that calls on load calls again.
    useOutbox.setState({ drafts: {} });
    const again = await start(messages);
    await widgetCalls(again.container, "拆开最慢的一步");
    await widgetCalls(again.container, "拆开最慢的一步");
    expect(sends).toHaveLength(0);
    expect(useOutbox.getState().outgoing).toHaveLength(0);
  });
});
