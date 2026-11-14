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

// Text already on the page stays the same elements while the reply grows and lands: drawn again
// from scratch, it would flash and lose any selection in it. These run the real Markdown and
// compare the elements themselves. Streamed text comes in plain, with no animation on it.

const AGENT = "a1";
let conversations = 0;

/** The paragraph of the block saying `text`, which comes in without an animation. */
function paragraph(container: HTMLElement, text: string) {
  const block = [
    ...container.querySelectorAll(".message-content, .process-note"),
  ].find((element) => element.textContent === text);
  if (block === undefined) throw new Error(`no block says ${text}`);
  expect(block.outerHTML).not.toContain("data-sd-animate");
  return block.querySelector("p")!;
}

const said = (timestamp: number, content: object[]) => ({
  role: "assistant",
  timestamp,
  content,
});
const entry = (seq: number, message: object): ViewMessageRow =>
  ({ entryId: `e${seq}`, seq, at: seq, message }) as ViewMessageRow;

const asked = entry(1, { role: "user", content: "查一下", timestamp: 1 });

/** A chat whose reply is at work, its session holding `rows`, and the ways the session moves. */
async function opened(
  kind: "group" | "direct",
  rows: ViewMessageRow[],
  data: Record<string, unknown> = {},
) {
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
    data,
  });
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
    transcript: { messages: rows },
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
        transcript: { messages: [...rows, ...messages] },
      }),
    );
    await flush(80);
  };
  return { container, stream, commit };
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
});

describe.each(["group", "direct"] as const)(
  "a reply that is writing, in a %s",
  (kind) => {
    it("keeps the elements of the words it has shown, across the turns of a run", async () => {
      const { container, stream, commit } = await opened(kind, [asked]);
      const call = {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: { command: "ls" },
      };

      await stream(said(10, [{ type: "text", text: "我先" }]));
      const shown = paragraph(container, "我先");
      await stream(said(10, [{ type: "text", text: "我先看看" }]));
      expect(paragraph(container, "我先看看")).toBe(shown);

      // A call follows the words: they were a step, and go into the process box, in their order.
      const first = said(10, [{ type: "text", text: "我先看看" }, call]);
      await stream(first);
      const step = paragraph(container, "我先看看");
      expect(step.closest(".process-box")).not.toBeNull();
      // The message lands in the transcript, and the tool it called runs and answers.
      await commit([entry(2, first)]);
      expect(paragraph(container, "我先看看")).toBe(step);
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
      expect(paragraph(container, "我先看看")).toBe(step);

      // The next turn's words are a block of their own, under the folded process.
      await stream(said(20, [{ type: "text", text: "看完了" }]));
      await flush(1600);
      expect(
        paragraph(container, "看完了").closest(".process-fold"),
      ).toBeNull();
      expect(
        paragraph(container, "我先看看").closest(".process-fold"),
      ).not.toBeNull();
    });

    // The row goes to work before the view has the message that started the run: for a moment the
    // newest things the session holds are the last run's, and drawn here they would show twice.
    it("draws nothing of the last reply before this one's first block", async () => {
      const lastAnswer = said(5, [{ type: "text", text: "上一轮的回答" }]);
      const { container, stream, commit } = await opened(
        kind,
        [asked, entry(2, lastAnswer)],
        { runFrom: 2 },
      );
      const reply = container.querySelector(".message.assistant")!;
      expect(reply.textContent).not.toContain("上一轮的回答");
      expect(reply.querySelector('[role="status"]')).not.toBeNull();

      const next = entry(3, { role: "user", content: "再查", timestamp: 6 });
      await commit([next]);
      expect(reply.textContent).not.toContain("上一轮的回答");
      expect(reply.querySelector('[role="status"]')).not.toBeNull();

      const answer = said(10, [{ type: "text", text: "这一轮的回答" }]);
      await stream(answer);
      expect(reply.textContent).not.toContain("上一轮的回答");
      expect(reply.textContent).toContain("这一轮的回答");
      expect(reply.querySelector('[role="status"]')).toBeNull();
    });

    // A runtime's stream can reach the page before the transcript's next push does.
    it("draws only this reply when its stream overtakes the transcript", async () => {
      const lastAnswer = said(5, [{ type: "text", text: "上一轮的回答" }]);
      const { container, stream } = await opened(
        kind,
        [asked, entry(2, lastAnswer)],
        { runFrom: 2 },
      );
      await stream(said(10, [{ type: "text", text: "这一轮的回答" }]));
      const reply = container.querySelector(".message.assistant")!;
      expect(reply.textContent).toContain("这一轮的回答");
      expect(reply.textContent).not.toContain("上一轮的回答");
    });
  },
);
