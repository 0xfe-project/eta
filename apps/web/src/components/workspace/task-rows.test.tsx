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
    data: { title: "整理发布说明", description: "## 目标\n\n列出变更" },
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
    assignee: "none",
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
    expect(container.textContent).toContain("尚未创建任务");
    expect(link(container)).toBeNull();

    const open = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("编辑并创建"),
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
        assignee: "none",
      },
    });
    // The reply carries the row, so the card is there before the timeline's next push.
    expect(link(container)?.getAttribute("href")).toBe("/?view=tasks&task=t9");
    expect(container.textContent).not.toContain("尚未创建任务");
    expect(container.textContent).toContain("待办");
  });

  it("refreshes the card when the task moves, and marks it when the task is deleted", async () => {
    const { container, host } = await chat([card()]);
    expect(link(container)?.textContent).toContain("待办");
    expect(container.textContent).not.toContain("评论");

    await push(host, [
      {
        ...card({
          status: "done",
          assignee: "user",
          comments: 2,
          summary: "已经合并了",
          artifacts: [{ artifactId: "art1", title: "季度报告", version: 3 }],
        }),
        revision: 3,
      },
    ]);
    expect(link(container)?.textContent).toContain("已完成");
    expect(container.textContent).toContain("2 条评论");
    expect(container.textContent).toContain("已经合并了");
    expect(container.textContent).toContain("季度报告 · 第 3 版");

    await push(host, [{ ...card({ deleted: true }), revision: 4 }]);
    expect(link(container)).toBeNull();
    expect(container.textContent).toContain("任务已删除");
  });
});

describe("a routine's report", () => {
  it("says it in the reader's language and opens the report", async () => {
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
    const opened =
      container.querySelector<HTMLAnchorElement>(".system-message a")!;
    expect(opened.textContent).toBe("例行任务「日报」发来报告：今日要闻");
    expect(opened.getAttribute("href")).toBe(
      "/?view=routines&routine=r1&run=run1",
    );
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
    expect(container.querySelector(".system-message a")?.textContent).toBe(
      "例行任务「日报」发来报告",
    );
  });
});

describe("an artifact an agent publishes", () => {
  it("shows its card under the tool call, and opens the version", async () => {
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
    await act(async () => open.click());
    await flush();
    expect(host.calls.find((c) => c.action === "preview")?.args).toEqual({
      artifactId: "art1",
      version: 3,
    });
  });
});
