import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useTaskDraft } from "./task-draft";
import { CommentBox, Timeline } from "./tasks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-13T00:00:00Z";
const sha = "0123456789abcdef0123456789abcdef01234567";
const pr = "https://github.com/acme/web/pull/7";
const assignee = {
  kind: "remote",
  computer_id: "c1",
  computer_name: "工作站",
  runtime: "paseo",
  provider: "claude",
};
const run = (id: string, assist: boolean, status: string) => ({
  id,
  status,
  computer_id: "c1",
  computer_name: "工作站",
  runtime: "paseo",
  provider: assist ? "codex" : "claude",
  workspace: null,
  nudged: false,
  error: null,
  created_at: at,
  sent_at: at,
  finished_at: null,
  assist,
});
const activity = (
  id: string,
  kind: string,
  actor: string,
  run_id: string | null,
  body: string | null,
  data: Record<string, unknown> = {},
) => ({ id, kind, actor: { kind: actor }, run_id, body, data, created_at: at });

const detail = {
  id: "t1",
  number: 1,
  title: "修登录页",
  status: "in_progress",
  assignee,
  comments: 1,
  run_status: "running",
  updated_at: at,
  description: "",
  created_by: { kind: "user" },
  created_at: at,
  activity: [
    activity("a1", "run_started", "system", "r1", null),
    activity("a2", "deliverable", "remote", "r1", null, {
      ...assignee,
      kind: "pull_request",
      url: pr,
    }),
    activity("a3", "assist", "user", "r2", "审查 PR 的边界情况", {
      computer_id: "c1",
      computer_name: "工作站",
      runtime: "paseo",
      provider: "codex",
      pull: { url: pr, head_sha: sha },
    }),
    activity("a4", "run_started", "system", "r2", null),
    activity("a5", "comment", "remote", "r2", "Safari 下间距有问题。", {
      computer_id: "c1",
      computer_name: "工作站",
      runtime: "paseo",
      provider: "codex",
      assist: true,
    }),
  ],
  runs: [run("r1", false, "running"), run("r2", true, "completed")],
} as unknown as TaskDetail;

const tasks = {
  tasks: [],
  assignees: [
    { ...assignee, runtime: "herdr", provider: "codex", online: false },
    { ...assignee, online: true },
    { ...assignee, provider: "codex", online: true },
  ],
};

function Detail() {
  const { data } = useQuery<TaskDetail>({
    queryKey: ["tasks", "t1"],
    queryFn: () => new Promise(() => {}),
    staleTime: Infinity,
  });
  return data ? (
    <>
      <Timeline task={data} />
      <CommentBox task={data} />
    </>
  ) : null;
}

let posts: { url: string; body: Record<string, unknown> }[] = [];
const cleanup: (() => void)[] = [];

async function render(task: TaskDetail = detail) {
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    // The forge's client fetches by URL, the control plane's by Request.
    if (typeof input === "string" && input.includes("/pulls?"))
      return Response.json({
        url: pr,
        title: "Fix",
        state: "open",
        additions: 1,
        deletions: 1,
        head_sha: sha,
      });
    const request = input as Request;
    if (typeof input === "string" || request.method !== "POST")
      return new Promise<Response>(() => {});
    posts.push({ url: request.url, body: await request.json() });
    return Response.json(task, { status: 201 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["tasks", "t1"], task);
  client.setQueryData(["tasks"], tasks);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Detail />
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    client.clear();
    container.remove();
  });
  return container;
}

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
  rstest.restoreAllMocks();
  useTaskDraft.setState({ drafts: {} });
  posts = [];
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  )!;
const click = (label: string) => act(async () => button(label).click());
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

async function type(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("请 Agent 协助", () => {
  it("replaces 让智能体反馈 under the comment box", async () => {
    const c = await render();
    expect(c.textContent).toContain("请 Agent 协助");
    expect(c.textContent).not.toContain("让智能体反馈");
  });

  it("shows the request and the answer under the agent's name only", async () => {
    const c = await render();
    const timeline =
      c.querySelector('ol[aria-label="时间线"]')!.textContent ?? "";
    expect(timeline).toContain("我 请 工作站 · Paseo · Codex 协助");
    expect(timeline).toContain("审查 PR 的边界情况");
    expect(timeline).toContain("acme/web/pull/7 @ 0123456");
    expect(timeline).toContain("已回复");
    // The assist's start is its request, not a second line.
    expect(timeline).not.toContain("工作站 · Paseo · Codex 开始工作");
    expect(timeline).toContain("工作站 · Paseo · Claude 开始工作");
    // Its answer: the agent's name, no purpose.
    const answer = [...c.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("Safari 下间距有问题。"),
    )!;
    expect(answer.querySelector(".font-medium")!.textContent).toBe(
      "工作站 · Paseo · Codex",
    );
    expect(timeline).not.toContain("代码审查");
  });

  it("hands an answer to the assignee through the comment box", async () => {
    const c = await render();
    await click("交给主执行者");
    const box = c.querySelector<HTMLTextAreaElement>("#task-comment")!;
    expect(box.value).toContain("> Safari 下间距有问题。");
    expect(box.value).toContain("工作站 · Paseo · Codex 的协助结果");
    expect(posts).toEqual([]);
  });

  it("asks another agent on the task's computer, pinned to the PR's head", async () => {
    await render();
    await click("请 Agent 协助");
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    // Online agents other than the assignee, in its runtime, come first.
    expect(dialog.textContent).toContain("工作站 · Paseo · Codex");
    expect(dialog.textContent).toContain("固定在当前 head 0123456");
    await act(async () =>
      (
        [...dialog.querySelectorAll("button")].find(
          (b) => b.textContent === "代码审查",
        ) as HTMLButtonElement
      ).click(),
    );
    const request =
      dialog.querySelector<HTMLTextAreaElement>("#assist-request")!;
    expect(request.value).toContain("审查交付的改动");
    await type(request, "看一下 Safari");
    await act(async () =>
      request.form!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("/api/v1/tasks/t1/assists");
    expect(posts[0].body).toEqual({
      runtime: "paseo",
      provider: "codex",
      request: "看一下 Safari",
      pull: { url: pr, head_sha: sha },
    });
  });

  it("says how to assign the task before it can be assisted", async () => {
    await render({
      ...detail,
      assignee: { kind: "user" },
    } as unknown as TaskDetail);
    await click("请 Agent 协助");
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("还没有指派到远程电脑");
    expect(dialog.querySelector("#assist-request")).toBeNull();
  });
});
