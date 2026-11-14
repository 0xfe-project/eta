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

/** A conversation whose reply is still working, with its session's run fed by message events. */
async function live(kind: "group" | "direct" = "group") {
  conversations += 1;
  const id = `process-box-${conversations}`;
  const host = surfaceHost({
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [
      conversationView({
        id,
        kind,
        participants: [memberView("a1", { sessionId: "s1" })],
      }),
    ],
    messages: {
      [id]: [
        messageView({
          conversationId: id,
          author: "agent",
          agentId: "a1",
          status: "working",
          text: "",
        }),
      ],
    },
  });
  host.target("sessions.s1", {
    core: { session: "s1", running: true },
    model: { id: "p:m", thinkingLevel: "off" },
    transcript: { messages: [] },
  });
  host.handle("sessions.resync", () => ({}));
  const mounted = await mount(<Chat conversationId={id} />);
  await flush();
  const say = async (...content: Record<string, unknown>[]) => {
    await act(async () =>
      host.socket.receive({
        type: "event",
        target: "sessions.s1",
        name: "message:update",
        data: { message: { role: "assistant", content, timestamp: 5 } },
      }),
    );
    await flush(60);
  };
  return { ...mounted, say };
}
const thought = { type: "thinking", thinking: "想一想" };
const call = (id: string) => ({
  type: "toolCall",
  id,
  name: "shell",
  arguments: { command: id },
});
const words = (text: string) => ({ type: "text", text });

// A direct chat and a group draw a reply's process by the same rules.
describe.each(["group", "direct"] as const)(
  "a reply's process in a %s",
  (kind) => {
    it("sits in a labelled, focusable scroll box with its steps while it works", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"), call("b"));
      const box = container.querySelector<HTMLElement>(".process-box");
      expect(box?.getAttribute("role")).toBe("region");
      expect(box?.getAttribute("aria-label")).toBeTruthy();
      expect(box?.tabIndex).toBe(0);
      expect(box?.querySelectorAll(".tool-card")).toHaveLength(2);
      expect(box?.querySelectorAll(".thinking-block")).toHaveLength(1);
      expect(container.querySelector(".process-fold")).toBeNull();
    });

    it("folds into a thinking process row once it writes the final text", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"), words("正在写答案"));
      // Until no call has followed it for a moment, the text is the box's next line.
      expect(container.querySelector(".process-fold")).toBeNull();
      expect(
        container.querySelector(".process-box .process-note")?.textContent,
      ).toBe("正在写答案");
      await flush(1600);
      expect(container.querySelector(".process-box")).toBeNull();
      const fold = container.querySelector<HTMLDetailsElement>(".process-fold");
      expect(fold?.open).toBe(false);
      expect(fold?.querySelector("summary")?.textContent).toContain("思考过程");
      expect(fold?.querySelector("summary")?.textContent).toContain("2 步");
      // The text is below the row, not in it, and only once.
      expect(fold?.textContent).not.toContain("正在写答案");
      expect(container.querySelectorAll(".message-content")).toHaveLength(1);
    });

    it("keeps a sentence before a call in the box, where it stays: the box does not fold for it", async () => {
      const { container, say } = await live(kind);
      await say(call("a"), words("先说一句"));
      const note = container.querySelector(".process-box .process-note");
      expect(note?.textContent).toBe("先说一句");
      expect(container.querySelector(".process-fold")).toBeNull();
      await say(call("a"), words("先说一句"), call("b"));
      expect(container.querySelector(".process-fold")).toBeNull();
      expect(container.querySelector(".process-box .process-note")).toBe(note);
      expect(
        container.querySelectorAll(".process-box .tool-card"),
      ).toHaveLength(2);
      await say(call("a"), words("先说一句"), call("b"), words("最终"));
      await flush(1600);
      expect(container.querySelector(".process-box")).toBeNull();
      expect(container.querySelector(".process-fold")).not.toBeNull();
    });

    it("draws text before any step as the answer at once, with no box", async () => {
      const { container, say } = await live(kind);
      await say(words("直接回答"));
      expect(container.querySelector(".process-box")).toBeNull();
      expect(container.querySelector(".process-fold")).toBeNull();
      expect(container.querySelector(".message-content")?.textContent).toBe(
        "直接回答",
      );
    });

    it("is a folded row once finished, and opens in place to its steps", async () => {
      const { container } = await start(kind, 8);
      expect(container.querySelector(".process-box")).toBeNull();
      const fold = container.querySelector<HTMLDetailsElement>(".process-fold");
      expect(fold?.open).toBe(false);
      expect(fold?.querySelector("summary")?.textContent).toContain("思考过程");
      expect(fold?.querySelector("summary")?.textContent).toContain("9 步");
      expect(fold?.textContent).not.toContain("最终答案");
      expect(container.textContent).toContain("最终答案");
      await click(fold?.querySelector("summary"));
      expect(fold?.open).toBe(true);
      expect(fold?.querySelectorAll(".tool-card")).toHaveLength(8);
      expect(fold?.querySelectorAll(".thinking-block")).toHaveLength(1);
    });

    it("has no box without thinking or tools", async () => {
      conversations += 1;
      const id = `process-box-${conversations}`;
      surfaceHost({
        agents: [agentView({ id: "a1", name: "研究员" })],
        conversations: [
          conversationView({
            id,
            kind,
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

    it("opens every step and the answer in a dialog, from the box and the folded row", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"));
      const more = container.querySelector(".process-box")?.nextElementSibling;
      expect(more?.tagName).toBe("BUTTON");
      expect(more?.textContent).toBe("查看全部");
      await click(more);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await cleanup();
      setWire(undefined);

      const finished = await start(kind, 8);
      await click(finished.container.querySelector(".process-fold summary"));
      await click(
        finished.container.querySelector<HTMLElement>(".process-fold button"),
      );
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.querySelectorAll(".tool-card")).toHaveLength(8);
      expect(dialog?.querySelectorAll(".thinking-block")).toHaveLength(1);
      expect(dialog?.textContent).toContain("最终答案");
      if (kind === "group") expect(dialog?.textContent).toContain("研究员");
    });
  },
);

describe("a reply's process dialog", () => {
  const T = 1_800_000_000_000;
  /** A finished group reply whose run is still in its member's session, with times. */
  async function timed(runFrom: number | undefined = 1) {
    conversations += 1;
    const id = `process-box-${conversations}`;
    const host = surfaceHost({
      agents: [agentView({ id: "a1", name: "研究员" })],
      conversations: [
        conversationView({
          id,
          kind: "group",
          participants: [memberView("a1", { sessionId: "s1" })],
        }),
      ],
      messages: {
        [id]: [
          messageView({
            conversationId: id,
            author: "agent",
            agentId: "a1",
            text: "最终答案",
            // 1:00 on the clock of whoever runs the test, whatever its time zone.
            createdAt: new Date(1970, 0, 1, 1, 0).getTime(),
            data: {
              ...(runFrom === undefined ? {} : { runFrom }),
              activity: [
                {
                  id: "c1",
                  name: "bash",
                  input: { command: "ls" },
                  output: "ok",
                  status: "completed",
                },
              ],
            },
          }),
        ],
      },
    });
    const row = (seq: number, at: number, message: object) => ({
      entryId: `e${seq}`,
      seq,
      at: T + at,
      message,
    });
    host.target("sessions.s1", {
      core: { session: "s1", running: false },
      transcript: {
        messages: [
          row(1, 0, { role: "user", content: "上一次", timestamp: T }),
          row(2, 100, { role: "user", content: "这一次", timestamp: T + 100 }),
          row(3, 3000, {
            role: "assistant",
            timestamp: T + 105,
            content: [
              {
                type: "toolCall",
                id: "c1",
                name: "bash",
                arguments: { command: "ls" },
              },
            ],
          }),
          row(4, 9000, {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            isError: false,
            content: [{ type: "text", text: "ok" }],
            timestamp: T + 9000,
          }),
          row(5, 11_000, {
            role: "assistant",
            timestamp: T + 9005,
            content: [{ type: "text", text: "最终答案" }],
          }),
        ],
      },
    });
    host.handle("sessions.resync", () => ({}));
    const mounted = await mount(<Chat conversationId={id} />);
    await flush();
    await click(mounted.container.querySelector(".process-fold summary"));
    await click(
      mounted.container.querySelector<HTMLElement>(".process-fold button"),
    );
    await flush();
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it("is headed by the author's face, name and time on one line, with the run's strip", async () => {
    const dialog = await timed();
    const line = dialog.querySelector<HTMLElement>(".h-7")!;
    expect(line.querySelector("svg, [aria-hidden='true']")).not.toBeNull();
    const time = line.querySelector("time")!.textContent;
    expect(time).toBe("1-01 01:00");
    expect(line.textContent).toBe(`研究员${time}展开`);
    const toolbar = dialog.querySelector('[role="toolbar"]')!;
    // From this reply's briefing on; the run before it is not this one's.
    expect(toolbar.getAttribute("aria-label")).toBe("3 步，用时 0:10");
    expect(
      [...toolbar.querySelectorAll("button")].map(
        (b) => b.getAttribute("aria-label")?.split("，")[0],
      ),
    ).toEqual(["生成", "bash", "生成"]);
  });

  it("finds a finished reply's run by the call it kept, when its row lost where it started", async () => {
    const dialog = await timed(undefined);
    expect(
      dialog.querySelector('[role="toolbar"]')?.getAttribute("aria-label"),
    ).toBe("3 步，用时 0:10");
  });

  it("sends the dialog to the step picked", async () => {
    const dialog = await timed();
    const bash = [...dialog.querySelectorAll('[role="toolbar"] button')].find(
      (b) => b.getAttribute("aria-label")?.startsWith("bash"),
    );
    await click(bash);
    const hit = dialog.querySelector("[data-hit]");
    expect(hit?.getAttribute("data-block")).toBe("c1");
    expect(hit?.querySelector(".tool-card")).not.toBeNull();
  });
});

describe("a reply before its first token", () => {
  const placeholder = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="status"]')].find(
      (status) => status.textContent === "思考中",
    );

  it("holds the process box in a group, at work, until the first block", async () => {
    const { container, say } = await live();
    const box = container.querySelector<HTMLElement>(".process-box");
    expect(box).not.toBeNull();
    expect(placeholder(container)?.closest(".process-box")).toBe(box);
    expect(
      box?.querySelector(".motion-safe\\:after\\:animate-skeleton-sweep"),
    ).not.toBeNull();
    await say(thought);
    expect(placeholder(container)).toBeUndefined();
    expect(
      container.querySelector(".process-box .thinking-block"),
    ).not.toBeNull();
  });

  it("holds the process box in a direct chat too, gone once text arrives", async () => {
    const { container, say } = await live("direct");
    expect(placeholder(container)?.closest(".process-box")).not.toBeNull();
    await say(words("开始写"));
    expect(placeholder(container)).toBeUndefined();
    expect(container.querySelector(".process-box")).toBeNull();
    expect(container.textContent).toContain("开始写");
  });

  it("is not on a finished reply", async () => {
    const { container } = await start("group", 2);
    expect(placeholder(container)).toBeUndefined();
  });
});

/** The process's steps as one line each: a thought, a call, or words, in the order drawn. */
const order = (root: ParentNode | null | undefined) =>
  [
    ...(root?.querySelectorAll(
      ".thinking-block, .tool-card-label, .process-note",
    ) ?? []),
  ].map((step) =>
    step.classList.contains("thinking-block")
      ? "thinking"
      : step.classList.contains("process-note")
        ? `text:${step.textContent}`
        : `tool:${step.textContent}`,
  );

describe.each(["group", "direct"] as const)(
  "the words between a reply's calls, in a %s",
  (kind) => {
    it("go into the process in their order while it works, and the answer under it", async () => {
      const { container, say } = await live(kind);
      await say(
        thought,
        words("先列目录"),
        call("a"),
        words("再看文件"),
        call("b"),
      );
      const running = order(container.querySelector(".process-box"));
      expect(running).toEqual([
        "thinking",
        "text:先列目录",
        "tool:shell · a",
        "text:再看文件",
        "tool:shell · b",
      ]);
      await say(
        thought,
        words("先列目录"),
        call("a"),
        words("再看文件"),
        call("b"),
        words("答案"),
      );
      await flush(1600);
      const fold = container.querySelector(".process-fold");
      expect(fold?.querySelector("summary")?.textContent).toContain("5 步");
      expect(order(fold)).toEqual(running);
      expect(fold?.textContent).not.toContain("答案");
    });

    it("are where they were once the reply is finished, read from its row", async () => {
      conversations += 1;
      const id = `process-box-${conversations}`;
      surfaceHost({
        agents: [agentView({ id: "a1", name: "研究员" })],
        conversations: [
          conversationView({
            id,
            kind,
            participants: [memberView("a1", { sessionId: "s1" })],
          }),
        ],
        messages: {
          [id]: [
            messageView({
              conversationId: id,
              author: "agent",
              agentId: "a1",
              thinking: "想一想",
              text: "答案",
              data: {
                activity: activity(2),
                process: [
                  { type: "thinking", text: "想一想" },
                  { type: "text", text: "先列目录" },
                  { type: "tool", id: "t0" },
                  { type: "text", text: "再看文件" },
                  { type: "tool", id: "t1" },
                  { type: "text", text: "答案" },
                ],
              },
            }),
          ],
        },
      });
      const { container } = await mount(<Chat conversationId={id} />);
      await flush();
      const fold = container.querySelector(".process-fold");
      expect(fold?.querySelector("summary")?.textContent).toContain("5 步");
      expect(order(fold)).toEqual([
        "thinking",
        "text:先列目录",
        "tool:shell · step-0",
        "text:再看文件",
        "tool:shell · step-1",
      ]);
      // The answer once, under the process.
      expect(fold?.textContent).not.toContain("答案");
      expect(
        [...container.querySelectorAll(".message-content")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["答案"]);
      // Every card folded, a finished one as a running one.
      expect(
        [...container.querySelectorAll<HTMLDetailsElement>(".tool-card")].some(
          (card) => card.open,
        ),
      ).toBe(false);
    });
  },
);

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
      folded={false}
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
