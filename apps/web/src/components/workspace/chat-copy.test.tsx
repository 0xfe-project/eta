import type { MessageView } from "@eta/client-contracts";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
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
import { cleanup, click, flush, mount } from "@/test-render";

const AGENT = "a1";
let CONV = "";
let conversations = 0;
let n = 0;
const row = (fields: Partial<MessageView>): MessageView => {
  n += 1;
  return messageView({
    id: `${CONV}-${n}`,
    conversationId: CONV,
    seq: n,
    ...fields,
  });
};

let copied: string[] = [];
beforeEach(() => {
  n = 0;
  conversations += 1;
  CONV = `chat-copy-${conversations}`;
  copied = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        copied.push(text);
      },
    },
  });
});

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useOutbox.setState({ drafts: {}, outgoing: [] });
});

function start(history: MessageView[], kind: "group" | "direct") {
  const summary = conversationView({
    id: CONV,
    kind,
    name: "官网改版",
    participants: [memberView(AGENT, { sessionId: "s1" })],
    lastSeq: n,
  });
  surfaceHost({
    agents: [agentView({ id: AGENT, name: "Ada" })],
    conversations: [summary],
    messages: { [CONV]: history },
  });
  return mount(<Chat conversationId={CONV} />);
}

const footerButton = (message: Element | null | undefined) =>
  message?.querySelector(":scope > .message-footer .message-copy-btn");

describe("the copy button beside a message's time", () => {
  it("is under your own message, inside the time, and copies what you wrote as written", async () => {
    const text = "@Ada 把 **OG 图**换成新的\n\nSafari 下也测一下";
    const { container } = await start(
      [
        row({
          text,
          data: {
            attachments: [
              { id: "f1", name: "og.png", contentType: "image/png", size: 10 },
            ],
          },
        }),
      ],
      "direct",
    );
    await flush();
    const user = container.querySelector(".message.user");
    const footer = user?.querySelector(":scope > .message-footer");
    const button = footerButton(user)!;
    expect(button).not.toBeNull();
    // The line is right-aligned, so the button comes before the time: on its inner side.
    expect(footer?.firstElementChild).toBe(button);
    expect(footer?.lastElementChild?.tagName).toBe("TIME");
    expect(button.textContent).toBe("复制");

    await click(button);
    await flush();
    expect(copied).toEqual([text]);
    expect(button.textContent).toBe("已复制");
  });

  it("still copies a reply's Markdown, after its time", async () => {
    const user = row({ text: "问题" });
    const { container } = await start(
      [
        user,
        row({
          author: "agent",
          agentId: AGENT,
          replyToId: user.id,
          text: "已换成 **1200×630** 的新图",
        }),
      ],
      "direct",
    );
    await flush();
    const reply = container.querySelector(".message.assistant");
    const footer = reply?.querySelector(":scope > .message-footer");
    expect(footer?.firstElementChild?.tagName).toBe("TIME");
    const button = footerButton(reply)!;
    expect(footer?.lastElementChild).toBe(button);
    await click(button);
    await flush();
    expect(copied).toEqual(["已换成 **1200×630** 的新图"]);
  });

  it("is on a group reply whose process is folded into a box", async () => {
    const user = row({ text: "问题" });
    const { container } = await start(
      [
        user,
        row({
          author: "agent",
          agentId: AGENT,
          replyToId: user.id,
          thinking: "先看 OG 图从哪里来。",
          text: "换好了",
          data: {
            activity: [
              {
                id: "t1",
                name: "bash",
                input: { command: "ls" },
                output: "",
                status: "completed",
              },
            ],
          },
        }),
      ],
      "group",
    );
    await flush();
    const reply = container.querySelector(".message.assistant");
    expect(reply?.querySelector(".process-fold")).not.toBeNull();
    const button = footerButton(reply)!;
    expect(button).not.toBeNull();
    await click(button);
    await flush();
    expect(copied).toEqual(["换好了"]);
  });

  it("shows when focused from the keyboard, and stays up where nothing can hover", () => {
    const styles = readFileSync(
      new URL("../../styles.css", import.meta.url),
      "utf8",
    );
    // The rule that reveals it names hover, keyboard focus and the copied beat together.
    const reveal =
      styles
        .match(/([^{}]*)\{\s*opacity: 1;\s*\}/g)
        ?.find((rule) => rule.includes(".message:hover .message-copy-btn")) ??
      "";
    expect(reveal).toContain(".message-copy-btn:focus-visible");
    expect(reveal).toContain('.message-copy-btn[data-copied="true"]');
    // A touch screen: always shown, after (so over) the hidden default.
    const hidden = styles.indexOf(
      "opacity: 0;",
      styles.indexOf(".message-copy-btn {"),
    );
    const touch = styles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{\s*\.message-copy-btn \{\s*opacity: 1;/,
    );
    expect(touch).not.toBeNull();
    expect(touch!.index!).toBeGreaterThan(hidden);
  });
});
