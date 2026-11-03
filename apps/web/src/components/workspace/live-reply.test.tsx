import type { MessageView, ViewMessageRow } from "@eta/client-contracts";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { Chat } from "@/test-chat";
import { surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationView,
  memberView,
  messageView,
} from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";

// The words of a reply fade in one character at a time, and Streamdown only knows which ones it
// has shown while its component lives: drawn again from scratch, every character fades in again.
// These run the real Markdown and read what the browser would animate: a character's animation
// plays when its element is put on the page, so the ones that fade are the elements new since the
// last look that still have a duration (Streamdown gives the ones it has shown none).

const AGENT = "a1";
let conversations = 0;

let seen = new WeakSet<Element>();

/** The characters of the block saying `text` that fade in since the last look. */
function fading(container: HTMLElement, text: string) {
  const block = [...container.querySelectorAll(".message-content")].find(
    (element) => element.textContent === text,
  );
  if (block === undefined) throw new Error(`no block says ${text}`);
  const spans = [...block.querySelectorAll<HTMLElement>("[data-sd-animate]")];
  const fresh = spans
    .filter(
      (span) =>
        !seen.has(span) && !span.style.cssText.includes("--sd-duration: 0ms"),
    )
    .map((span) => span.textContent)
    .join("");
  for (const span of spans) seen.add(span);
  return fresh;
}

const said = (timestamp: number, content: object[]) => ({
  role: "assistant",
  timestamp,
  content,
});
const entry = (seq: number, message: object): ViewMessageRow =>
  ({ entryId: `e${seq}`, seq, at: seq, message }) as ViewMessageRow;

afterEach(async () => {
  seen = new WeakSet();
  await cleanup();
  setWire(undefined);
});

describe.each(["group", "direct"] as const)(
  "a reply that is writing, in a %s",
  (kind) => {
    it("fades in only the words that are new, across the turns of a run", async () => {
      conversations += 1;
      const conversation = `live-reply-${conversations}`;
      const user: MessageView = messageView({
        id: `${conversation}-1`,
        conversationId: conversation,
        seq: 1,
        text: "查一下",
      });
      const reply: MessageView = messageView({
        id: `${conversation}-2`,
        conversationId: conversation,
        seq: 2,
        author: "agent",
        agentId: AGENT,
        replyToId: user.id,
        status: "working",
      });
      const asked = entry(1, { role: "user", content: "查一下", timestamp: 1 });
      const host = surfaceHost({
        agents: [agentView({ id: AGENT, name: "研究员" })],
        conversations: [
          conversationView({
            id: conversation,
            kind,
            name: "研究员",
            participants: [memberView(AGENT, { sessionId: "s1" })],
            lastSeq: 2,
          }),
        ],
        messages: { [conversation]: [user, reply] },
      });
      host.target("sessions.s1", {
        core: { session: "s1", running: true },
        transcript: { messages: [asked] },
      });
      host.handle("sessions.resync", () => ({}));
      const { container } = await mount(<Chat conversationId={conversation} />);
      await flush();
      const stream = async (message: object) => {
        await act(async () =>
          host.socket.receive({
            type: "event",
            target: "sessions.s1",
            name: "message:update",
            data: { message },
          }),
        );
        await flush(80);
      };
      const commit = async (messages: ViewMessageRow[]) => {
        await act(async () =>
          host.set("sessions.s1", {
            core: { session: "s1", running: true },
            transcript: { messages: [asked, ...messages] },
          }),
        );
        await flush(80);
      };
      const call = {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: { command: "ls" },
      };

      await stream(said(10, [{ type: "text", text: "我先" }]));
      expect(fading(container, "我先")).toBe("我先");
      await stream(said(10, [{ type: "text", text: "我先看看" }]));
      expect(fading(container, "我先看看")).toBe("看看");

      // The message lands in the transcript, and the tool it called runs and answers.
      const first = said(10, [{ type: "text", text: "我先看看" }, call]);
      await stream(first);
      await commit([entry(2, first)]);
      expect(fading(container, "我先看看")).toBe("");
      await commit([
        entry(2, first),
        entry(3, {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "a" }],
          isError: false,
          timestamp: 11,
        }),
      ]);
      expect(fading(container, "我先看看")).toBe("");

      // The next turn's words are new from their first character.
      await stream(said(20, [{ type: "text", text: "看完了" }]));
      expect(fading(container, "我先看看")).toBe("");
      expect(fading(container, "看完了")).toBe("看完了");
    });
  },
);
