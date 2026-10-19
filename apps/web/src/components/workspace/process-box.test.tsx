import type { MessageView } from "@eta/client-contracts";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
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
import { ProcessBox } from "./transcript/process-box";

const activity = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    name: "shell",
    input: { command: `step-${i}` },
    output: "ok",
    status: "completed",
  }));

let conversations = 0;
async function start(kind: "group" | "direct", tools: number) {
  conversations += 1;
  const id = `process-box-${conversations}`;
  const summary = conversationView({
    id,
    kind,
    participants: [memberView("a1", { sessionId: "s1" })],
  });
  const reply: MessageView = messageView({
    conversationId: id,
    author: "agent",
    agentId: "a1",
    thinking: "想一想",
    text: "最终答案",
    data: { activity: activity(tools) },
  });
  surfaceHost({
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [summary],
    messages: { [id]: [reply] },
  });
  const mounted = await mount(<Chat conversationId={id} />);
  await flush();
  return mounted;
}

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  useOutbox.setState({ drafts: {}, outgoing: [] });
});

describe("a reply's process in a group", () => {
  it("sits in a labelled, focusable scroll box with its steps", async () => {
    const { container } = await start("group", 8);
    const box = container.querySelector<HTMLElement>(".process-box");
    expect(box?.getAttribute("role")).toBe("region");
    expect(box?.getAttribute("aria-label")).toBeTruthy();
    expect(box?.tabIndex).toBe(0);
    expect(box?.querySelectorAll(".tool-card")).toHaveLength(8);
    expect(box?.querySelectorAll(".thinking-block")).toHaveLength(1);
    // The answer stays outside, below.
    expect(box?.textContent).not.toContain("最终答案");
    expect(container.textContent).toContain("最终答案");
  });

  it("has no box without thinking or tools", async () => {
    conversations += 1;
    const id = `process-box-${conversations}`;
    surfaceHost({
      agents: [agentView({ id: "a1", name: "研究员" })],
      conversations: [
        conversationView({
          id,
          participants: [memberView("a1", { sessionId: "s1" })],
        }),
      ],
      messages: {
        [id]: [
          messageView({
            conversationId: id,
            author: "agent",
            agentId: "a1",
            text: "只有文字",
          }),
        ],
      },
    });
    const { container } = await mount(<Chat conversationId={id} />);
    await flush();
    expect(container.querySelector(".process-box")).toBeNull();
  });

  it("opens every step and the answer in a dialog", async () => {
    const { container } = await start("group", 8);
    const more = container.querySelector(".process-box")?.nextElementSibling;
    expect(more?.tagName).toBe("BUTTON");
    await click(more);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelectorAll(".tool-card")).toHaveLength(8);
    expect(dialog?.querySelectorAll(".thinking-block")).toHaveLength(1);
    expect(dialog?.textContent).toContain("最终答案");
    expect(dialog?.textContent).toContain("研究员");
  });
});

describe("a reply's process in a direct chat", () => {
  it("is not boxed", async () => {
    const { container } = await start("direct", 3);
    expect(container.querySelector(".process-box")).toBeNull();
    expect(container.querySelectorAll(".tool-card")).toHaveLength(3);
  });
});

describe("following a running reply", () => {
  let box: HTMLElement;
  const measure = () => {
    Object.defineProperty(box, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(box, "clientHeight", {
      configurable: true,
      value: 176,
    });
  };
  const steps = (n: number) => (
    <ProcessBox
      steps={Array.from({ length: n }, (_, i) => <div key={i}>step {i}</div>)}
      count={n}
      running
      time="12:00"
      answer={null}
    />
  );
  let show: Awaited<ReturnType<typeof mount>>["show"];
  beforeEach(async () => {
    const mounted = await mount(steps(2));
    show = mounted.show;
    box = mounted.container.querySelector<HTMLElement>(".process-box")!;
    measure();
  });

  it("goes to the newest step", async () => {
    await show(steps(3));
    expect(box.scrollTop).toBe(1000);
  });

  it("stays where the reader scrolled to", async () => {
    box.scrollTop = 100;
    await act(async () => {
      box.dispatchEvent(new Event("scroll"));
    });
    await show(steps(3));
    expect(box.scrollTop).toBe(100);
  });
});
