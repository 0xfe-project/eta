import type { MessageView, TaskCardData } from "@eta/client-contracts";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWire } from "@/lib/wire";
import { Chat } from "@/test-chat";
import {
  agentView,
  artifactView,
  conversationSections,
  conversationView,
  memberView,
  messageView,
  productHost,
  taskDetail,
} from "@/test-product";
import { flush } from "@/test-render";

// The rows an agent and the host add to a conversation besides words: a task to confirm, the task
// once confirmed, a routine's report, and the card of what an agent published.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The rows a page has seen outlive a render, so each test has a conversation of its own.
let CONV = "";
let summary: ReturnType<typeof conversationView>;
let draft: MessageView;
let conversations = 0;
beforeEach(() => {
  conversations += 1;
  CONV = `c-rows-${conversations}`;
  summary = conversationView({
    id: CONV,
    name: "研究",
    participants: [memberView("a1", { sessionId: "s1" })],
  });
  draft = messageView({
    id: `draft-${conversations}`,
    conversationId: CONV,
    kind: "task_draft",
    author: "agent",
    agentId: "a1",
    data: {
      title: "整理发布说明",
      description: "## 目标\n\n列出变更",
      workspace: "worktree",
    },
  });
});
const card = (fields: Partial<TaskCardData> = {}): MessageView => ({
  ...draft,
  kind: "task_card",
  revision: 2,
  data: {
    taskId: "t9",
    number: 9,
    title: "整理发布说明",
    status: "todo",
    runStatus: null,
    conversationId: CONV,
    comments: 0,
    summary: "",
    artifacts: [],
    ...fields,
  } satisfies TaskCardData,
});

const disposers: (() => void)[] = [];
afterEach(async () => {
  await act(async () => disposers.splice(0).forEach((dispose) => dispose()));
  setWire(undefined);
});

async function chat(
  rows: MessageView[],
  prepare?: (host: ReturnType<typeof productHost>) => void,
) {
  const host = productHost({
    agents: [agentView({ id: "a1", name: "研究员" })],
    conversations: [summary],
    messages: { [CONV]: rows },
    tasks: [
      { task: taskDetail({ id: "t9", number: 9, title: "整理发布说明" }) },
    ],
    artifacts: [
      artifactView({
        id: "art1",
        title: "季度报告",
        versions: [
          {
            number: 3,
            files: 4,
            bytes: 10,
            size: 10,
            createdAt: 1,
            archiveUrl: "/artifacts/art1/3/archive.zip",
            shareUrl: null,
            sharedAt: null,
          },
        ],
      }),
    ],
  });
  prepare?.(host);
  host.handle("artifacts.preview", () => ({
    url: "/preview/c/files/",
    expiresAt: 1,
  }));
  host.hello();
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <NuqsAdapter>
          <Chat conversationId={CONV} />
        </NuqsAdapter>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  disposers.push(() => {
    root.unmount();
    container.remove();
  });
  await flush();
  return { container, host };
}

const push = (host: ReturnType<typeof productHost>, rows: MessageView[]) =>
  act(async () =>
    host.set(`conversations.${CONV}`, conversationSections(summary, rows)),
  );
const link = (c: HTMLElement) =>
  c.querySelector<HTMLAnchorElement>('a[aria-label^="打开任务"]');

describe("a task an agent proposes", () => {
  it("shows the draft to confirm, and the confirmed row becomes the task's card", async () => {
    const { container, host } = await chat([draft], (fake) => {
      fake.handle("tasks.confirmDraft", () => ({
        task: taskDetail({ id: "t9", number: 9, title: "整理发布说明" }),
        message: card(),
      }));
    });
    expect(container.textContent).toContain("整理发布说明");
    // What the user decides on: the agent that proposed it will run it, in a worktree of its own.
    expect(container.textContent).toContain("确认后创建任务");
    expect(container.textContent).toContain("独立 worktree");
    expect(link(container)).toBeNull();

    const open = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("编辑并确认"),
    )!;
    await act(async () => open.click());
    // The form opens on the draft's words; the user edits the title.
    const title = document.querySelector<HTMLInputElement>("#task-title")!;
    expect(title.value).toBe("整理发布说明");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(title, "整理 Q4 发布说明");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      title.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(host.calls.find((c) => c.action === "confirmDraft")?.args).toEqual({
      conversationId: CONV,
      messageId: draft.id,
      edits: {
        title: "整理 Q4 发布说明",
        description: "## 目标\n\n列出变更",
        status: "todo",
      },
    });
    // The reply carries the row, so the card is there before the timeline's next push.
    expect(link(container)?.getAttribute("href")).toBe("/?view=tasks&task=t9");
    expect(container.textContent).not.toContain("确认后创建任务");
    expect(container.textContent).toContain("待办");
  });

  it("refreshes the card when the task moves, and marks it when the task is deleted", async () => {
    const { container, host } = await chat([card()]);
    // The folded line is the card: it carries the number, the title, and where the task stands.
    expect(container.querySelector(".task-fold-head")?.textContent).toContain(
      "待办",
    );
    expect(container.textContent).not.toContain("评论");

    await push(host, [
      {
        ...card({
          status: "done",
          runStatus: "completed",
          comments: 2,
          summary: "已经合并了",
          artifacts: [{ artifactId: "art1", title: "季度报告", version: 3 }],
        }),
        revision: 3,
      },
    ]);
    expect(container.querySelector(".task-fold-head")?.textContent).toContain(
      "已完成",
    );
    expect(container.textContent).toContain("已完成 · 2 条评论");
    expect(container.textContent).toContain("已经合并了");
    expect(container.textContent).toContain("季度报告 · 第 3 版");

    await push(host, [{ ...card({ deleted: true }), revision: 4 }]);
    expect(link(container)).toBeNull();
    expect(container.textContent).toContain("任务已删除");
  });
});

describe("a draft belongs to the turn that wrote it", () => {
  // The reply an agent is writing when it drafts: the row the draft names, and the box it is drawn in.
  const turn = (fields: Partial<MessageView> = {}): MessageView =>
    messageView({
      conversationId: CONV,
      author: "agent",
      agentId: "a1",
      text: "我来起草",
      status: "queued",
      ...fields,
    });
  const within = (
    reply: MessageView | string,
    fields: Record<string, unknown> = {},
  ) =>
    messageView({
      conversationId: CONV,
      kind: "task_draft",
      author: "agent",
      agentId: "a1",
      data: {
        title: "整理发布说明",
        description: "## 目标\n\n列出变更",
        workspace: "worktree",
        turnMessageId: typeof reply === "string" ? reply : reply.id,
        ...fields,
      },
    });

  it("draws the draft inside that reply, and only one of them per turn", async () => {
    const reply = turn();
    const first = within(reply, { title: "整理发布说明" });
    const second = within(reply, { title: "补一份变更日志" });
    const { container } = await chat([reply, first, second]);
    // The turn's own box: the draft is in it, not a block of its own further down the timeline.
    const turnBox = container.querySelector(
      `#msg-${reply.id} .message.assistant`,
    );
    expect(turnBox).not.toBeNull();
    const folds = [...turnBox!.querySelectorAll("details.task-fold")];
    expect(folds).toHaveLength(2);
    expect(folds[0]?.textContent).toContain("整理发布说明");
    expect(folds[1]?.textContent).toContain("补一份变更日志");
    // Indentation says whose turn it came from; the draft is not a row of the timeline any more.
    expect(turnBox!.querySelector(".turn-tasks")).not.toBeNull();
    expect(
      container.querySelector(`#msg-${first.id}`)?.parentElement?.parentElement,
    ).toBe(turnBox);
  });

  it("keeps each draft in the turn that wrote it when the turns cross", async () => {
    const firstTurn = turn({ text: "先说发布说明" });
    const firstDraft = within(firstTurn, { title: "整理发布说明" });
    const secondTurn = turn({ text: "再说变更日志" });
    const secondDraft = within(secondTurn, { title: "补一份变更日志" });
    // A second agent was woken before the first had drafted, so the rows interleave.
    const { container } = await chat([
      firstTurn,
      secondTurn,
      firstDraft,
      secondDraft,
    ]);
    expect(
      container.querySelector(`#msg-${firstTurn.id} .task-fold`)?.textContent,
    ).toContain("整理发布说明");
    expect(
      container.querySelector(`#msg-${secondTurn.id} .task-fold`)?.textContent,
    ).toContain("补一份变更日志");
  });

  it("is open while the turn works, folded once it settles, and still asks then", async () => {
    const reply = turn();
    const row = within(reply);
    const { container, host } = await chat([reply, row]);
    const fold = container.querySelector(`#msg-${reply.id} .task-fold`);
    expect(fold?.hasAttribute("open")).toBe(true);

    // The turn ends. The draft is no longer news, so it becomes one line — and the one line still
    // says what it is, what it proposes, and how to confirm it.
    await push(host, [{ ...reply, status: "done", revision: 2 }]);
    expect(fold?.hasAttribute("open")).toBe(false);
    // The default moved, so the reader never said anything: the page remembers nothing about this
    // row, and a card with no choice of its own is free to follow the next default too.
    expect(
      JSON.parse(localStorage.getItem("eta.card-folds.v1") ?? "{}"),
    ).not.toHaveProperty(row.id);
    const head = container.querySelector(
      `#msg-${reply.id} .task-fold summary`,
    )!;
    expect(head.textContent).toContain("任务草稿");
    expect(head.textContent).toContain("整理发布说明");
    expect(head.textContent).toContain("待确认");
    // One click on the folded line reaches the form: the reader is not made to open the card first
    // to find the button, and the card stays out of the way while the form is answered.
    const confirm = [...head.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("编辑并确认"),
    )!;
    expect(fold?.hasAttribute("open")).toBe(false);
    await act(async () => confirm.click());
    expect(document.querySelector<HTMLInputElement>("#task-title")?.value).toBe(
      "整理发布说明",
    );
    // The button is the line's other purpose; it does not also throw the card open.
    expect(fold?.hasAttribute("open")).toBe(false);
  });

  it("draws a draft on its own when the turn it names is not on this page", async () => {
    // The reply is on an earlier page of the conversation. A card the reader can neither place nor
    // lose beats a card that vanished at the page boundary, so it stays where the timeline put it.
    const { container } = await chat([within("turn-not-loaded")]);
    const fold = container.querySelector("details.task-fold")!;
    expect(fold.textContent).toContain("整理发布说明");
    // A row of the timeline, where the timeline put it, with the same frame it always had.
    expect(fold.closest(".message.assistant")).toBeNull();
    expect(container.querySelector(".turn-tasks")).toBeNull();
  });

  it("keeps the fold the reader chose, through the turn settling and the reload", async () => {
    const reply = turn();
    const row = within(reply);
    const { container, host } = await chat([reply, row]);
    const fold = container.querySelector(`#msg-${reply.id} .task-fold`)!;
    // It is open because the turn is at work; the reader folds it themselves.
    await act(async () => {
      fold
        .querySelector("summary")!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    });
    expect(fold.hasAttribute("open")).toBe(false);

    // The turn settling would fold it anyway; what the reader said is what stands, and it is the
    // same after the page is rebuilt.
    await push(host, [{ ...reply, status: "done", revision: 2 }]);
    expect(fold.hasAttribute("open")).toBe(false);
    await act(async () => {
      host.set(`conversations.${CONV}`, conversationSections(summary, []));
    });
    const again = await chat([reply, row]);
    expect(
      again.container
        .querySelector(`#msg-${reply.id} .task-fold`)
        ?.hasAttribute("open"),
    ).toBe(false);
  });

  it("draws a card in that turn too, open, and folds when told", async () => {
    const reply = turn({ status: "done" });
    const row = {
      ...within(reply),
      kind: "task_card" as const,
      data: {
        taskId: "t9",
        number: 9,
        title: "整理发布说明",
        status: "todo",
        runStatus: null,
        conversationId: CONV,
        comments: 0,
        summary: "",
        artifacts: [],
        turnMessageId: reply.id,
      },
    };
    const { container } = await chat([reply, row]);
    const fold = container.querySelector(`#msg-${reply.id} .task-fold`)!;
    // A card is here because the reader confirmed it, so it is open until they say otherwise.
    expect(fold.hasAttribute("open")).toBe(true);
    expect(fold.querySelector("summary")?.textContent).toContain("待办");
    await act(async () => {
      fold
        .querySelector("summary")!
        .dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
    });
    expect(fold.hasAttribute("open")).toBe(false);
    expect(link(container)?.getAttribute("href")).toBe("/?view=tasks&task=t9");
  });
});

describe("a routine's report", () => {
  it("says it in the reader's language, with no page to open", async () => {
    const report = messageView({
      conversationId: CONV,
      kind: "system",
      author: "system",
      text: 'Routine "日报" sent a report.\n\n# 今日',
      data: {
        event: "routine_report",
        routineId: "r1",
        routineName: "日报",
        runId: "run1",
        title: "今日要闻",
      },
    });
    const { container } = await chat([report]);
    // 定时 is off in this build: the line stays as news, the link to its page does not.
    const notice = [...container.querySelectorAll(".system-message")].find(
      (node) => node.textContent?.includes("日报"),
    )!;
    expect(notice.textContent).toBe("例行任务「日报」发来报告：今日要闻");
    expect(notice.querySelector("a")).toBeNull();
  });

  it("falls back to the name alone for a report with no title", async () => {
    const report = messageView({
      conversationId: CONV,
      kind: "system",
      author: "system",
      data: {
        event: "routine_report",
        routineId: "r1",
        routineName: "日报",
        runId: "run1",
        title: null,
      },
    });
    const { container } = await chat([report]);
    const notice = [...container.querySelectorAll(".system-message")].find(
      (node) => node.textContent?.includes("日报"),
    )!;
    expect(notice.textContent).toBe("例行任务「日报」发来报告");
    expect(notice.querySelector("a")).toBeNull();
  });
});

describe("an artifact an agent publishes", () => {
  it("shows its card beside the answer, and opens the version", async () => {
    const user = messageView({ conversationId: CONV, text: "做个页面" });
    const reply = messageView({
      conversationId: CONV,
      author: "agent",
      agentId: "a1",
      replyToId: user.id,
      status: "working",
    });
    const { container, host } = await chat([user, reply], (fake) => {
      fake.target("sessions.s1", {
        core: { session: "s1", running: true },
        transcript: {
          messages: [
            {
              entryId: "e1",
              seq: 1,
              at: 1,
              message: { role: "user", content: "做个页面", timestamp: 1 },
            },
            {
              entryId: "e2",
              seq: 2,
              at: 2,
              message: {
                role: "assistant",
                timestamp: 2,
                content: [
                  {
                    type: "toolCall",
                    id: "p1",
                    name: "publish_artifact",
                    arguments: { title: "季度报告", dir: "out" },
                  },
                ],
              },
            },
            {
              entryId: "e3",
              seq: 3,
              at: 3,
              message: {
                role: "toolResult",
                toolCallId: "p1",
                toolName: "publish_artifact",
                content: [{ type: "text", text: "published" }],
                details: {
                  artifactId: "art1",
                  title: "季度报告",
                  version: 3,
                  files: 4,
                },
                isError: false,
                timestamp: 3,
              },
            },
          ],
        },
      });
      fake.handle("sessions.resync", () => ({}));
    });
    await flush(80);
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="打开 Artifact"]',
    )!;
    expect(open.getAttribute("aria-label")).toBe(
      "打开 Artifact 季度报告 第 3 版",
    );
    // Beside the answer, in the turn's own card layer, and not in the process frame the call is
    // drawn in: a group folds that away as soon as the reply writes its text, and the card of what
    // the reply produced is not something to fold away.
    expect(open.closest(".turn-tasks")).not.toBeNull();
    expect(open.closest(".process-box")).toBeNull();
    expect(open.closest(".process-fold")).toBeNull();
    const process = container.querySelector(".process-box, .process-fold")!;
    expect(process.textContent).toContain("publish_artifact");
    await act(async () => open.click());
    await flush();
    expect(host.calls.find((c) => c.action === "preview")?.args).toEqual({
      artifactId: "art1",
      version: 3,
    });
  });
});
