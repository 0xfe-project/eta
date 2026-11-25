import type { MessageView } from "@eta/client-contracts";
import { act } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { closeBrowser, hasBrowser, onPage } from "@/test-browser";
import { Chat } from "@/test-chat";
import { interactionView, surfaceHost } from "@/test-inbox";
import {
  agentView,
  conversationSections,
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
/**
 * Who is in it: a group has a second voice, so its rows say who spoke; an agent's own chat is a
 * group of one, and its rows do not repeat the name.
 */
const cast = (kind: "group" | "own") =>
  kind === "group"
    ? [memberView("a1", { sessionId: "s1" }), memberView("a2")]
    : [memberView("a1", { sessionId: "s1" })];
/** A group runs in a project; an agent's own chat runs in that agent's home project. */
const placeOf = (kind: "group" | "own") =>
  kind === "group" ? "p1" : "home-a1";
/**
 * The conversation as a host publishes it. Both are groups; the "own" one is the group of a single
 * member, in that agent's home project, which is what makes it the agent's own chat.
 */
const conversationOf = (kind: "group" | "own", id: string) =>
  conversationView({ id, projectId: placeOf(kind), participants: cast(kind) });
/** A group of several, and the group of one that is an agent's own chat. */
const SHAPES = [
  { kind: "group", what: "a group" },
  { kind: "own", what: "an agent's own chat" },
] as const;
async function start(kind: "group" | "own", tools: number) {
  conversations += 1;
  const id = `process-box-${conversations}`;
  const summary = conversationOf(kind, id);
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
async function live(kind: "group" | "own" = "group") {
  conversations += 1;
  const id = `process-box-${conversations}`;
  const summary = conversationOf(kind, id);
  const reply = messageView({
    id: `${id}-reply`,
    conversationId: id,
    author: "agent",
    agentId: "a1",
    status: "working",
    text: "",
  });
  const host = surfaceHost({
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [summary],
    messages: { [id]: [reply] },
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
  /** The run ends: the host writes the reply's row as it keeps a finished one. */
  const finish = async (...content: Record<string, unknown>[]) => {
    const row = finished(reply, content);
    await act(async () =>
      host.set(`conversations.${id}`, conversationSections(summary, [row])),
    );
    await flush(60);
    return row;
  };
  return { ...mounted, say, finish };
}
/**
 * `reply` once its run wrote `content` and ended, as the host keeps it: its text is the words at
 * the end, its process every block in order (`data.process`), its calls in `data.activity`.
 */
function finished(
  reply: MessageView,
  content: Record<string, unknown>[],
): MessageView {
  let end = content.length;
  while (end > 0 && content[end - 1]!.type === "text") end -= 1;
  return {
    ...reply,
    status: "done",
    revision: reply.revision + 1,
    text: content
      .slice(end)
      .map((part) => part.text)
      .join("\n\n"),
    data: {
      activity: content
        .filter((part) => part.type === "toolCall")
        .map((part) => ({
          id: part.id,
          name: part.name,
          input: part.arguments,
          output: "ok",
          status: "completed",
        })),
      process: content.map((part) =>
        part.type === "toolCall"
          ? { type: "tool", id: part.id }
          : part.type === "thinking"
            ? { type: "thinking", text: part.thinking }
            : { type: "text", text: part.text },
      ),
    },
  };
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

// A group and an agent's own chat (a group of one) draw a reply's process by the same rules.
describe.each(SHAPES)("a reply's process in $what", ({ kind }) => {
  it("sits in a labelled, focusable scroll box with its steps while it works", async () => {
    const { container, say } = await live(kind);
    await say(thought, call("a"), call("b"));
    const box = processBox(container);
    // A group names whose process it is; an agent's own chat has one agent to name.
    expect(box?.getAttribute("aria-label")).toBe(
      kind === "group" ? "研究员 的过程" : "过程",
    );
    expect(box?.tabIndex).toBe(0);
    expect(toolCards(box)).toHaveLength(2);
    expect(thoughts(box)).toHaveLength(1);
    expect(processFold(container)).toBeNull();
  });

  it("writes its words in the box until the run ends, then folds with the answer under it", async () => {
    const { container, say, finish } = await live(kind);
    await say(thought, call("a"), words("正在写答案"));
    // However long no call follows them, the words are the box's newest step: the run is not over.
    await flush(1600);
    expect(processFold(container)).toBeNull();
    expect(drawn(processBox(container)!, "正在写答案")).toBe(1);
    expect(drawn(container, "正在写答案")).toBe(1);

    await finish(thought, call("a"), words("正在写答案"));
    expect(processBox(container)).toBeNull();
    const fold = processFold(container);
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("summary")?.textContent).toBe("▶思考过程2 步");
    // The text is below the row, not in it, and only once.
    expect(fold?.textContent).not.toContain("正在写答案");
    expect(drawn(container, "正在写答案")).toBe(1);
  });

  it("keeps a sentence before a call in the box, where it stays", async () => {
    const { container, say } = await live(kind);
    await say(call("a"), words("先说一句"));
    const note = [...processBox(container)!.querySelectorAll("p")].find(
      (p) => p.textContent === "先说一句",
    );
    expect(note).toBeDefined();
    await say(call("a"), words("先说一句"), call("b"));
    expect(processFold(container)).toBeNull();
    expect(processBox(container)?.contains(note!)).toBe(true);
    expect(toolCards(processBox(container))).toHaveLength(2);
  });

  it("writes a reply with only words in the box too, and draws them whole once the run ends", async () => {
    const { container, say, finish } = await live(kind);
    await say(words("直接回答"));
    await flush(1600);
    expect(drawn(processBox(container)!, "直接回答")).toBe(1);
    expect(drawn(container, "直接回答")).toBe(1);

    await finish(words("直接回答"));
    // Nothing on the way to fold: the answer alone.
    expect(processBox(container)).toBeNull();
    expect(processFold(container)).toBeNull();
    expect(drawn(container, "直接回答")).toBe(1);
  });

  it("draws nothing of what it writes outside the box while it works", async () => {
    const { container, say } = await live(kind);
    const outside = () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          ".message.assistant p, .message.assistant .message-content",
        ),
      ].filter((element) => !processBox(container)?.contains(element));
    const moments = [
      [words("先看看")],
      [words("先看看"), call("a")],
      [words("先看看"), call("a"), thought, words("再看日志")],
      [words("先看看"), call("a"), thought, words("再看日志"), call("b")],
      [
        words("先看看"),
        call("a"),
        thought,
        words("再看日志"),
        call("b"),
        words("答案是这样"),
      ],
    ];
    for (const moment of moments) {
      await say(...moment);
      await flush(1600);
      expect(outside()).toEqual([]);
      expect(processFold(container)).toBeNull();
    }
  });

  it("draws a finished reply the same whether its run just ended or the page was opened after", async () => {
    const content = [
      thought,
      words("先列目录"),
      call("a"),
      words("再看文件"),
      call("b"),
      words("答案"),
    ];
    const { container, say, finish } = await live(kind);
    await say(...content);
    const row = await finish(...content);
    const ended = container.querySelector(`#msg-${row.id}`)!.innerHTML;
    await cleanup();
    setWire(undefined);

    const summary = conversationOf(kind, row.conversationId);
    surfaceHost({
      agents: [agentView({ id: "a1", name: "研究员" })],
      conversations: [summary],
      messages: { [row.conversationId]: [row] },
    });
    const reopened = await mount(<Chat conversationId={row.conversationId} />);
    await flush();
    expect(reopened.container.querySelector(`#msg-${row.id}`)!.innerHTML).toBe(
      ended,
    );
    expect(
      processFold(reopened.container)?.querySelector("summary")?.textContent,
    ).toBe("▶思考过程5 步");
    expect(drawn(reopened.container, "答案")).toBe(1);
  });

  it("keeps the question it asks the reader in full view under the box", async () => {
    conversations += 1;
    const id = `process-box-${conversations}`;
    const host = surfaceHost({
      interactions: [
        interactionView({
          id: "i1",
          agentId: "a1",
          conversationId: id,
          prompt: "删掉这个分支？",
          options: ["删", "留"],
        }),
      ],
      agents: [agentView({ id: "a1", name: "研究员" })],
      conversations: [
        conversationView({
          id,
          projectId: placeOf(kind),
          participants: [
            memberView("a1", {
              sessionId: "s1",
              status: "waiting_for_input",
            }),
          ],
        }),
      ],
      messages: {
        [id]: [
          messageView({
            conversationId: id,
            author: "agent",
            agentId: "a1",
            status: "waiting_for_input",
            text: "",
          }),
        ],
      },
    });
    host.target("sessions.s1", {
      core: { session: "s1", running: true },
      transcript: {
        messages: [
          {
            entryId: "e1",
            seq: 1,
            at: 1,
            message: {
              role: "assistant",
              timestamp: 1,
              content: [
                { type: "text", text: "分支已经合进去了，可以删。" },
                call("ask"),
              ],
            },
          },
        ],
      },
    });
    host.handle("sessions.resync", () => ({}));
    const { container } = await mount(<Chat conversationId={id} />);
    await flush();
    const box = processBox(container);
    expect(drawn(box!, "分支已经合进去了，可以删。")).toBe(1);
    const card = container.querySelector('section[aria-label="确认请求"]');
    expect(card?.textContent).toContain("删掉这个分支？");
    expect(box?.contains(card!)).toBe(false);
    expect(
      [...card!.querySelectorAll("button")].map((b) => b.textContent),
    ).toEqual(expect.arrayContaining(["删", "留"]));
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
      conversations: [conversationOf(kind, id)],
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
});

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
          participants: cast("group"),
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

  it("holds the process box in an agent's own chat too, its words written in it", async () => {
    const { container, say } = await live("own");
    expect(processBox(container)?.contains(placeholder(container)!)).toBe(true);
    await say(words("开始写"));
    expect(placeholder(container)).toBeUndefined();
    expect(drawn(processBox(container)!, "开始写")).toBe(1);
  });

  it("is not on a finished reply", async () => {
    const { container } = await start("group", 2);
    expect(placeholder(container)).toBeUndefined();
  });
});

/** The process's steps as one line each: a thought, a call, or words, in the order drawn. */
const order = (root: ParentNode | null | undefined) =>
  [...(root?.querySelectorAll(".thinking-block, .tool-card-label") ?? [])].map(
    (step) =>
      step.classList.contains("note-step")
        ? `text:${step.querySelector(".note-step-content")?.textContent}`
        : step.classList.contains("thinking-block")
          ? "thinking"
          : `tool:${step.textContent}`,
  );
/** What the agent said, as steps: folds headed "说明". */
const notes = (root: ParentNode | null | undefined) =>
  folds(root).filter(({ head }) => head === "▶说明");

describe.each(SHAPES)(
  "what an agent says in its process, in $what",
  ({ kind }) => {
    it("is a step headed 说明, open from the start and folded by its head, while a thought stays folded", async () => {
      const { container, say } = await live(kind);
      await say(thought, words("先说一句"), call("a"), words("再说一句"));
      const box = processBox(container);
      const [first, second] = notes(box);
      expect(notes(box)).toHaveLength(2);
      expect(first?.details.open).toBe(true);
      expect(second?.details.open).toBe(true);
      expect(drawn(first!.details, "先说一句")).toBe(1);
      expect(thoughts(box)[0]?.details.open).toBe(false);
      // Still open once more words stream in: a new token does not fold it back or open it twice.
      await say(thought, words("先说一句"), call("a"), words("再说一句，接着"));
      expect(notes(box)[1]?.details.open).toBe(true);
      await click(first!.details.querySelector("summary"));
      expect(first!.details.open).toBe(false);
      expect(notes(box)[1]?.details.open).toBe(true);
    });

    it("keeps that step in the finished process, and leaves the answer under it as it was", async () => {
      const { container, say, finish } = await live(kind);
      const content = [thought, words("先列目录"), call("a"), words("答案")];
      await say(...content);
      await finish(...content);
      const fold = processFold(container)!;
      await click(fold.querySelector("summary"));
      expect(notes(fold)).toHaveLength(1);
      expect(notes(fold)[0]?.details.open).toBe(true);
      expect(thoughts(fold)[0]?.details.open).toBe(false);
      // The answer is not a step: no 说明 over it, drawn in the reply's own text.
      const answer = [...container.querySelectorAll("p")].find(
        (p) => p.textContent === "答案",
      );
      expect(answer?.closest(".note-step")).toBeNull();
      expect(answer?.closest(".message-content")).not.toBeNull();
    });
  },
);

describe.each(SHAPES)(
  "the words between a reply's calls, in $what",
  ({ kind }) => {
    it("go into the process in their order while it works, the last ones too, and stay there once it ends", async () => {
      const { container, say, finish } = await live(kind);
      const content = [
        thought,
        words("先列目录"),
        call("a"),
        words("再看文件"),
        call("b"),
        words("答案"),
      ];
      await say(...content);
      await flush(1600);
      const running = order(processBox(container));
      expect(running).toEqual([
        "thinking",
        "text:先列目录",
        "tool:shell · a",
        "text:再看文件",
        "tool:shell · b",
        "text:答案",
      ]);
      await finish(...content);
      const fold = processFold(container);
      expect(fold?.querySelector("summary")?.textContent).toContain("5 步");
      // The words at the end are the answer now, under the row; the rest is as it was.
      expect(order(fold)).toEqual(running.slice(0, -1));
      expect(fold?.textContent).not.toContain("答案");
      expect(drawn(container, "答案")).toBe(1);
    });

    it("are where they were once the reply is finished, read from its row", async () => {
      conversations += 1;
      const id = `process-box-${conversations}`;
      surfaceHost({
        agents: [agentView({ id: "a1", name: "研究员" })],
        conversations: [conversationOf(kind, id)],
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

describe.each(SHAPES)("a finished reply's folded row, in $what", ({ kind }) => {
  it("says how many steps it took and nothing more", async () => {
    const { container } = await start(kind, 3);
    const head = processFold(container)?.querySelector("summary");
    expect(head?.textContent).toBe("▶思考过程4 步");
    expect(container.textContent).toContain("最终答案");
  });
});

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
  /** Words that take many lines: more than the frame holds. */
  const many = Array.from<string>({ length: 6 }).fill(long).join("\n\n");

  it("keeps one height from its first token on, through its words, calls and long answer", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await live("group");
    const moments: string[] = [];
    // Before its first token, the frame already holds the place.
    moments.push(reply(container));
    await say(words("我先看看配置"));
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
      words(many),
    );
    expect(drawn(processBox(container)!, long)).toBe(6);
    moments.push(reply(container));
    const heights = [];
    for (const markup of moments) heights.push(await height(markup));
    expect(heights[0]).toBeGreaterThan(150);
    expect(new Set(heights).size).toBe(1);
  });

  it("draws what it says in a thought's small type, headings too, and the answer at the reader's size", async ({
    skip,
  }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say, finish } = await live("group");
    const said = "# 发现\n\n- `baseUrl` 少了 /v1\n\n还要看日志";
    const content = [thought, words(said), call("a"), words("答案")];
    await say(...content);
    /** Font size and colour of the note's heading, item and line, and of the answer, as drawn. */
    const sizes = (markup: string) =>
      onPage(`<div style="width: 640px">${markup}</div>`, async (page) =>
        page.evaluate(() => {
          const style = (el: Element | null | undefined) =>
            el ? getComputedStyle(el).fontSize : null;
          const note = document.querySelector(".note-step-content");
          const answer = [
            ...document.querySelectorAll(".message-content p"),
          ].find((p) => p.textContent === "答案");
          return {
            heading: style(note?.querySelector("h1")),
            item: style(note?.querySelector("li")),
            line: style(note?.querySelector("p")),
            answer: style(answer),
          };
        }),
      );
    const working = await sizes(reply(container));
    expect(working).toEqual({
      heading: "12px",
      item: "12px",
      line: "12px",
      answer: null,
    });
    await finish(...content);
    await click(processFold(container)?.querySelector("summary"));
    const done = await sizes(reply(container));
    expect(done).toEqual({ ...working, answer: "14px" });
  });

  it("does not move a reply under it while both work", async ({ skip }) => {
    if (!(await hasBrowser())) return skip();
    const { container, say } = await twoAtWork();
    const above = (...content: Record<string, unknown>[]) =>
      say("s1", ...content);
    await say("s2", words("我去查日志"), call("x"));
    const replies = () => [...container.querySelectorAll(".message.assistant")];
    const tops: number[] = [];
    /** Where the reply under starts, with what the one above has written so far in its box. */
    const measure = async (newest?: string) => {
      const [first, second] = replies();
      // Both feeds reach their replies: a dead one would leave nothing to move.
      expect(drawn(processBox(second)!, "我去查日志")).toBe(1);
      if (newest !== undefined)
        expect(drawn(processBox(first)!, newest)).toBeGreaterThan(0);
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
    await measure();
    // It speaks, adds steps, then writes something many lines long.
    await above(call("a"), words("我先看看配置"), call("b"));
    await measure("我先看看配置");
    await above(
      call("a"),
      words("我先看看配置"),
      call("b"),
      thought,
      call("c"),
    );
    await measure("我先看看配置");
    await above(
      call("a"),
      words("我先看看配置"),
      call("b"),
      thought,
      call("c"),
      words(many),
    );
    await measure(long);
    expect(tops[0]).toBeGreaterThan(150);
    expect(new Set(tops).size).toBe(1);
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
