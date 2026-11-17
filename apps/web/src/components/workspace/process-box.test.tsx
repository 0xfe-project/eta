import type { MessageView } from "@eta/client-contracts";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { closeBrowser, hasBrowser, onPage } from "@/test-browser";
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
/** A group with two replies at work, one per member, each fed by its own session's run. */
async function twoAtWork() {
  conversations += 1;
  const id = `process-box-${conversations}`;
  const host = surfaceHost({
    agents: [
      agentView({ id: "a1", name: "研究员" }),
      agentView({ id: "a2", name: "运维" }),
    ],
    conversations: [
      conversationView({
        id,
        kind: "group",
        participants: [
          memberView("a1", { sessionId: "s1" }),
          memberView("a2", { sessionId: "s2" }),
        ],
      }),
    ],
    messages: {
      [id]: ["a1", "a2"].map((agentId) =>
        messageView({
          conversationId: id,
          author: "agent",
          agentId,
          status: "working",
          text: "",
        }),
      ),
    },
  });
  for (const session of ["s1", "s2"])
    host.target(`sessions.${session}`, {
      core: { session, running: true },
      model: { id: "p:m", thinkingLevel: "off" },
      transcript: { messages: [] },
    });
  host.handle("sessions.resync", () => ({}));
  const mounted = await mount(<Chat conversationId={id} />);
  await flush();
  const say = async (
    session: string,
    ...content: Record<string, unknown>[]
  ) => {
    await act(async () =>
      host.socket.receive({
        type: "event",
        target: `sessions.${session}`,
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
/** The running process: the scroll box a screen reader calls "…的过程". */
const processBox = (root: ParentNode | null | undefined) =>
  root?.querySelector<HTMLElement>('[role="region"][aria-label$="过程"]') ??
  null;
/** The folds under `root` with the line their own summary says. */
const folds = (root: ParentNode | null | undefined) =>
  [...(root?.querySelectorAll<HTMLDetailsElement>("details") ?? [])].map(
    (details) => ({
      details,
      head: details.querySelector(":scope > summary")?.textContent ?? "",
    }),
  );
/** The finished process, folded to one line: "思考过程 … N 步". */
const processFold = (root: ParentNode | null | undefined) =>
  folds(root).find(({ head }) => /思考过程.*\d 步/.test(head))?.details ?? null;
/** A thought, folded: "思考过程 · N 字". */
const thoughts = (root: ParentNode | null | undefined) =>
  folds(root).filter(({ head }) => /思考过程 · \d+ 字/.test(head));
/** A call's card: a fold headed by the tool's name. */
const toolCards = (root: ParentNode | null | undefined) =>
  folds(root).filter(({ head }) => /^(?:shell|bash)\b/.test(head));
/** How many times `text` is drawn as its own block of words under `root`. */
const drawn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("p")].filter((p) => p.textContent === text).length;
/** Open the folded process, then its "查看全部". */
async function openAll(root: ParentNode) {
  const fold = processFold(root);
  await click(fold?.querySelector("summary"));
  await click(
    [...(fold?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "查看全部",
    ),
  );
}

// A direct chat and a group draw a reply's process by the same rules.
describe.each(["group", "direct"] as const)(
  "a reply's process in a %s",
  (kind) => {
    it("sits in a labelled, focusable scroll box with its steps while it works", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"), call("b"));
      const box = processBox(container);
      // A group names whose process it is; a direct chat has one agent to name.
      expect(box?.getAttribute("aria-label")).toBe(
        kind === "group" ? "研究员 的过程" : "过程",
      );
      expect(box?.tabIndex).toBe(0);
      expect(toolCards(box)).toHaveLength(2);
      expect(thoughts(box)).toHaveLength(1);
      expect(processFold(container)).toBeNull();
    });

    it("folds into a thinking process row once it writes the final text", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"), words("正在写答案"));
      // Until no call has followed it for a moment, the text is the box's next line.
      expect(processFold(container)).toBeNull();
      expect(drawn(processBox(container)!, "正在写答案")).toBe(1);
      await flush(1600);
      expect(processBox(container)).toBeNull();
      const fold = processFold(container);
      expect(fold?.open).toBe(false);
      expect(fold?.querySelector("summary")?.textContent).toContain("思考过程");
      expect(fold?.querySelector("summary")?.textContent).toContain("2 步");
      // The text is below the row, not in it, and only once.
      expect(fold?.textContent).not.toContain("正在写答案");
      expect(drawn(container, "正在写答案")).toBe(1);
    });

    it("keeps a sentence before a call in the box, where it stays: the box does not fold for it", async () => {
      const { container, say } = await live(kind);
      await say(call("a"), words("先说一句"));
      const note = [...processBox(container)!.querySelectorAll("p")].find(
        (p) => p.textContent === "先说一句",
      );
      expect(note).toBeDefined();
      expect(processFold(container)).toBeNull();
      await say(call("a"), words("先说一句"), call("b"));
      expect(processFold(container)).toBeNull();
      expect(processBox(container)?.contains(note!)).toBe(true);
      expect(toolCards(processBox(container))).toHaveLength(2);
      await say(call("a"), words("先说一句"), call("b"), words("最终"));
      await flush(1600);
      expect(processBox(container)).toBeNull();
      expect(processFold(container)).not.toBeNull();
    });

    it("draws text before any step as the answer at once, with no box", async () => {
      const { container, say } = await live(kind);
      await say(words("直接回答"));
      expect(processBox(container)).toBeNull();
      expect(processFold(container)).toBeNull();
      expect(drawn(container, "直接回答")).toBe(1);
    });

    it("is a folded row once finished, and opens in place to its steps", async () => {
      const { container } = await start(kind, 8);
      expect(processBox(container)).toBeNull();
      const fold = processFold(container);
      expect(fold?.open).toBe(false);
      expect(fold?.querySelector("summary")?.textContent).toContain("思考过程");
      expect(fold?.querySelector("summary")?.textContent).toContain("9 步");
      expect(fold?.textContent).not.toContain("最终答案");
      expect(container.textContent).toContain("最终答案");
      await click(fold?.querySelector("summary"));
      expect(fold?.open).toBe(true);
      expect(toolCards(fold)).toHaveLength(8);
      expect(thoughts(fold)).toHaveLength(1);
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
      expect(processBox(container)).toBeNull();
      expect(processFold(container)).toBeNull();
      expect(container.textContent).toContain("只有文字");
    });

    it("opens every step and the answer in a dialog, from the box and the folded row", async () => {
      const { container, say } = await live(kind);
      await say(thought, call("a"));
      const more = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "查看全部",
      );
      await click(more);
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await cleanup();
      setWire(undefined);

      const finished = await start(kind, 8);
      await openAll(finished.container);
      const dialog = document.querySelector('[role="dialog"]');
      expect(toolCards(dialog)).toHaveLength(8);
      expect(thoughts(dialog)).toHaveLength(1);
      expect(dialog?.textContent).toContain("最终答案");
      if (kind === "group") expect(dialog?.textContent).toContain("研究员");
    });
  },
);

describe("a reply's process dialog", () => {
  const T = 1_800_000_000_000;
  /** A finished group reply whose run is still in its member's session, with times. */
  async function timed(runFrom: number | undefined = 1, effort?: object) {
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
            ...(effort === undefined ? {} : { effort }),
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
            ...(effort === undefined ? {} : { effort }),
            timestamp: T + 9005,
            content: [{ type: "text", text: "最终答案" }],
          }),
        ],
      },
    });
    host.handle("sessions.resync", () => ({}));
    const mounted = await mount(<Chat conversationId={id} />);
    await flush();
    await openAll(mounted.container);
    await flush();
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  it("is headed by the author's face, name and time on one line, with the run's strip", async () => {
    const dialog = await timed();
    // The line the 展开 toggle sits on; the face leads it, drawn for the eye only.
    const line = dialog.querySelector("button[aria-expanded]")!.parentElement!;
    expect(line.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
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

  describe("says the run's thinking level: what was asked → what was sent", () => {
    const note = (dialog: HTMLElement) =>
      dialog.querySelector<HTMLElement>('[data-testid="run-effort"]');

    it("as it is when the model took it (or its levels were unknown and it was passed)", async () => {
      const dialog = await timed(1, { asked: "ultra", sent: "ultra" });
      expect(note(dialog)?.textContent).toBe("· 思考档 ultra → ultra");
      expect(note(dialog)?.className).not.toContain("text-state-warning");
    });

    it("in the warning colour when the model did not take it", async () => {
      const dialog = await timed(1, { asked: "ultra", sent: null });
      expect(note(dialog)?.textContent).toBe(
        "· 思考档 ultra → 模型默认（不支持）",
      );
      expect(note(dialog)?.className).toContain("text-state-warning");
    });

    it("as the model's default when nothing was asked", async () => {
      const dialog = await timed(1, { asked: null, sent: null });
      expect(note(dialog)?.textContent).toBe("· 思考档 跟随模型默认");
      expect(note(dialog)?.className).not.toContain("text-state-warning");
    });

    it("not at all for a run that wrote no record", async () => {
      const dialog = await timed();
      expect(note(dialog)).toBeNull();
    });
  });

  it("sends the dialog to the step picked", async () => {
    const dialog = await timed();
    const bash = [...dialog.querySelectorAll('[role="toolbar"] button')].find(
      (b) => b.getAttribute("aria-label")?.startsWith("bash"),
    );
    await click(bash);
    const hit = dialog.querySelector("[data-hit]");
    expect(hit?.getAttribute("data-block")).toBe("c1");
    expect(toolCards(hit)).toHaveLength(1);
  });
});

describe("a reply before its first token", () => {
  const placeholder = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="status"]')].find(
      (status) => status.textContent === "思考中",
    );

  it("holds the process box in a group, at work, until the first block", async () => {
    const { container, say } = await live();
    const box = processBox(container);
    expect(box).not.toBeNull();
    expect(box?.contains(placeholder(container)!)).toBe(true);
    await say(thought);
    expect(placeholder(container)).toBeUndefined();
    expect(thoughts(processBox(container))).toHaveLength(1);
  });

  it("holds the process box in a direct chat too, gone once text arrives", async () => {
    const { container, say } = await live("direct");
    expect(processBox(container)?.contains(placeholder(container)!)).toBe(true);
    await say(words("开始写"));
    expect(placeholder(container)).toBeUndefined();
    expect(processBox(container)).toBeNull();
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
      const running = order(processBox(container));
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
      const fold = processFold(container);
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
      const fold = processFold(container);
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
      expect(drawn(container, "答案")).toBe(1);
      // Every card folded, a finished one as a running one.
      expect(toolCards(container).some(({ details }) => details.open)).toBe(
        false,
      );
    });
  },
);

/** The line over a reply's box: what it said last, on its way. */
const saidLine = (root: ParentNode | null | undefined) =>
  root?.querySelector<HTMLElement>(".process-said-line") ?? null;

describe.each(["group", "direct"] as const)(
  "what a reply said on its way, in a %s",
  (kind) => {
    it("stays over the box from the first call on, and the newest sentence takes its place", async () => {
      const { container, say } = await live(kind);
      // Before any step, words are the reply: no box, no line.
      await say(words("我先看看配置"));
      expect(processBox(container)).toBeNull();
      expect(saidLine(container)).toBeNull();
      expect(drawn(container, "我先看看配置")).toBe(1);

      // The first call: the sentence stays, as the line over the box, and is not a step in it.
      await say(words("我先看看配置"), call("a"));
      expect(saidLine(container)?.textContent).toBe("我先看看配置");
      expect(order(processBox(container))).toEqual(["tool:shell · a"]);
      expect(container.textContent?.split("我先看看配置")).toHaveLength(2);

      // More calls: the line holds.
      await say(words("我先看看配置"), call("a"), thought, call("b"));
      expect(saidLine(container)?.textContent).toBe("我先看看配置");

      // A new sentence between calls takes the line, and stays in the box as a step too.
      await say(
        words("我先看看配置"),
        call("a"),
        thought,
        call("b"),
        words("再查日志"),
        call("c"),
      );
      expect(saidLine(container)?.textContent).toBe("再查日志");
      expect(order(processBox(container))).toEqual([
        "tool:shell · a",
        "thinking",
        "tool:shell · b",
        "text:再查日志",
        "tool:shell · c",
      ]);
      expect(processFold(container)).toBeNull();

      // The answer: the box folds to one row that ends with the last sentence, and the line goes.
      await say(
        words("我先看看配置"),
        call("a"),
        thought,
        call("b"),
        words("再查日志"),
        call("c"),
        words("答案是这样"),
      );
      // Not yet the answer: it is what was said last.
      expect(saidLine(container)?.textContent).toBe("答案是这样");
      await flush(1600);
      expect(saidLine(container)).toBeNull();
      expect(processBox(container)).toBeNull();
      const head = processFold(container)?.querySelector("summary");
      expect(head?.textContent).toBe("▶思考过程· 6 步 ·再查日志");
      expect(head?.querySelector(".process-said")?.textContent).toBe(
        "再查日志",
      );
      expect(drawn(container, "答案是这样")).toBe(1);
      // Opened, the row has every step in its order, the first sentence included.
      expect(order(processFold(container))).toEqual([
        "text:我先看看配置",
        "tool:shell · a",
        "thinking",
        "tool:shell · b",
        "text:再查日志",
        "tool:shell · c",
      ]);
    });

    it("keeps the sentence over the box in the whole process the dialog opens", async () => {
      const { container, say } = await live(kind);
      await say(words("我先看看配置"), call("a"));
      await click(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === "查看全部",
        ),
      );
      expect(order(document.querySelector('[role="dialog"]'))).toEqual([
        "text:我先看看配置",
        "tool:shell · a",
      ]);
    });

    it("holds its line before anything is said, so a reply that calls first keeps its height when it speaks", async () => {
      const { container, say } = await live(kind);
      // Before the first token the line is already there, empty.
      expect(saidLine(container)?.textContent).toBe("");
      await say(call("a"));
      const line = saidLine(container);
      expect(line?.textContent).toBe("");
      await say(call("a"), words("看下一个"), call("b"));
      // The same element, now with words.
      expect(saidLine(container)).toBe(line);
      expect(line?.textContent).toBe("看下一个");
    });

    it("ends a finished reply's folded row, read from its row", async () => {
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
              text: "答案",
              data: {
                activity: activity(2),
                process: [
                  { type: "text", text: "先列目录" },
                  { type: "tool", id: "t0" },
                  { type: "text", text: "再看\n文件" },
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
      const head = processFold(container)?.querySelector("summary");
      expect(head?.textContent).toBe("▶思考过程· 4 步 ·再看 文件");
      expect(saidLine(container)).toBeNull();
    });

    it("leaves an old reply's folded row as it was when its row kept no words", async () => {
      const { container } = await start(kind, 3);
      const head = processFold(container)?.querySelector("summary");
      expect(head?.textContent).toBe("▶思考过程4 步");
      expect(head?.querySelector(".process-said")).toBeNull();
      expect(container.textContent).toContain("最终答案");
    });
  },
);

/**
 * The height a reply at work takes, as a browser draws it: the markup the chat rendered at each
 * moment, on a page styled by the app's compiled stylesheet. happy-dom lays nothing out, so a line
 * that wraps or a frame that grows only shows here.
 */
describe("a reply at work, as a browser draws it", () => {
  afterAll(closeBrowser);

  /** The reply's outer height, in a column as wide as a chat's. */
  const height = (markup: string) =>
    onPage(`<div style="width: 640px">${markup}</div>`, async (page) =>
      page
        .locator(".message.assistant")
        .last()
        .evaluate((el) => el.getBoundingClientRect().height),
    );
  const reply = (root: HTMLElement) =>
    [...root.querySelectorAll(".message.assistant")].at(-1)!.outerHTML;
  const long =
    "这是一句很长很长的话，长到一行放不下：先确认 baseUrl 有没有带 /v1，再看 CPA 的日志里 401 是哪一步返回的，最后对一下 key 是不是过期了，然后再决定要不要重启。";

  it("keeps one height from its first call on, through new calls and new sentences", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await live("group");
    const moments: string[] = [];
    // Before its first token, the frame and its line already hold the place.
    moments.push(reply(container));
    await say(words("我先看看配置"), call("a"));
    moments.push(reply(container));
    await say(words("我先看看配置"), call("a"), thought, call("b"), call("c"));
    moments.push(reply(container));
    await say(
      words("我先看看配置"),
      call("a"),
      thought,
      call("b"),
      call("c"),
      words(long),
      call("d"),
    );
    moments.push(reply(container));
    expect(saidLine(container)?.textContent).toBe(long);
    const heights = [];
    for (const markup of moments) heights.push(await height(markup));
    expect(heights[0]).toBeGreaterThan(200);
    expect(new Set(heights).size).toBe(1);
  });

  it("draws what it just said as one visible line, cut with an ellipsis", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await live("group");
    await say(words(long), call("a"));
    const line = await onPage(
      `<div style="width: 640px">${reply(container)}</div>`,
      async (page) =>
        page.locator(".process-said-line").evaluate((el) => {
          const style = getComputedStyle(el);
          return {
            height: el.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(style.lineHeight),
            visible: style.display !== "none" && style.visibility !== "hidden",
            cut: el.scrollWidth > el.clientWidth,
            ellipsis: style.textOverflow,
          };
        }),
    );
    expect(line.visible).toBe(true);
    expect(line.height).toBeGreaterThan(0);
    expect(line.height).toBeCloseTo(line.lineHeight, 0);
    expect(line.cut).toBe(true);
    expect(line.ellipsis).toBe("ellipsis");
  });

  it("does not move a reply under it while both work", async ({ skip }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await twoAtWork();
    const above = (...content: Record<string, unknown>[]) =>
      say("s1", ...content);
    await say("s2", words("我去查日志"), call("x"));
    const replies = () => [...container.querySelectorAll(".message.assistant")];
    const tops: number[] = [];
    const measure = async () => {
      const [first, second] = replies();
      expect(second?.querySelector(".process-said-line")?.textContent).toBe(
        "我去查日志",
      );
      tops.push(
        await onPage(
          `<div style="width: 640px">${first!.outerHTML}${second!.outerHTML}</div>`,
          async (page) =>
            page
              .locator(".message.assistant")
              .last()
              .evaluate((el) => el.getBoundingClientRect().top),
        ),
      );
    };
    expect(replies()).toHaveLength(2);
    // Before its first token, then calling without a word yet.
    await measure();
    await above(call("a"));
    expect(saidLine(replies()[0])?.textContent ?? "").toBe("");
    await measure();
    // It speaks, adds steps, then says something long in place of what it said.
    await above(call("a"), words("我先看看配置"), call("b"));
    expect(saidLine(replies()[0])?.textContent).toBe("我先看看配置");
    await measure();
    await above(
      call("a"),
      words("我先看看配置"),
      call("b"),
      thought,
      call("c"),
    );
    await measure();
    await above(
      call("a"),
      words("我先看看配置"),
      call("b"),
      thought,
      call("c"),
      words(long),
      call("d"),
    );
    expect(saidLine(replies()[0])?.textContent).toBe(long);
    await measure();
    expect(tops[0]).toBeGreaterThan(200);
    expect(new Set(tops).size).toBe(1);
  });

  it("does not grow when a reply that called first says something", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await live("direct");
    await say(call("a"));
    const silent = reply(container);
    await say(call("a"), words(long), call("b"));
    expect(await height(reply(container))).toBe(await height(silent));
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
      folded={false}
      time="12:00"
      answer={null}
    />
  );
  let show: Awaited<ReturnType<typeof mount>>["show"];
  beforeEach(async () => {
    const mounted = await mount(steps(2));
    show = mounted.show;
    box = processBox(mounted.container)!;
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
