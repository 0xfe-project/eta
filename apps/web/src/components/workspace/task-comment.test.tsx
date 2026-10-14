import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { CommentBox, Timeline } from "./tasks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-11T00:00:00Z";
const detail = {
  id: "t1",
  number: 1,
  title: "测试任务",
  status: "in_progress",
  assignee: {
    kind: "remote",
    computer_id: "c1",
    computer_name: "工作站",
    runtime: "paseo",
    provider: "codex",
  },
  comments: 0,
  run_status: null,
  updated_at: at,
  description: "",
  created_by: { kind: "user" },
  created_at: at,
  activity: [],
  runs: [],
  assists: [],
  loops: [],
} as unknown as TaskDetail;

const commented = (task: TaskDetail, body: string): TaskDetail => ({
  ...task,
  activity: [
    ...task.activity,
    {
      id: `a${task.activity.length + 1}`,
      kind: "comment",
      actor: { kind: "user" },
      run_id: null,
      body,
      data: {},
      created_at: at,
    } as TaskDetail["activity"][number],
  ],
});

/** The detail's timeline and its box, both on the cached task, as the views wire them. */
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

// happy-dom drops a Request's headers, so the retry's Idempotency-Key (the
// first try's) is checked in a browser, not here.
interface Post {
  body: { body: string };
  resolve: (response: Response) => void;
}
let posts: Post[] = [];

const cleanup: (() => void)[] = [];
async function render() {
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input as Request;
    if (request.method !== "POST") return new Promise<Response>(() => {}); // Refreshes never settle here.
    const body = await request.json();
    return new Promise<Response>((resolve) => posts.push({ body, resolve }));
  });
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["tasks", "t1"], detail);
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
  return { container, client };
}

const box = (c: HTMLElement) =>
  c.querySelector<HTMLTextAreaElement>("textarea")!;
const button = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  )!;
const timeline = (c: HTMLElement) =>
  c.querySelector('ol[aria-label="时间线"]')!.textContent ?? "";
const outgoing = (c: HTMLElement) =>
  c.querySelector('ol[aria-label="待发送"]')?.textContent ?? null;

async function type(c: HTMLElement, text: string) {
  const textarea = box(c);
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const send = (c: HTMLElement) =>
  act(async () =>
    box(c).form!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    ),
  );
/** Lets the fetch mock read the request. */
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

async function respond(post: Post, response: Response) {
  await act(async () => {
    post.resolve(response);
    await new Promise((r) => setTimeout(r, 10));
  });
}
const ok = (body: string) =>
  new Response(JSON.stringify(commented(detail, body)), { status: 201 });
const failed = () =>
  new Response(
    JSON.stringify({ error: { code: "CONFLICT", message: "任务已结束" } }),
    { status: 409 },
  );

describe("follow-up comments", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    rstest.restoreAllMocks();
    posts = [];
  });

  it("moves the comment out of the box when sent and into the timeline when it arrives", async () => {
    const { container } = await render();
    await type(container, "再看一下日志");
    await send(container);
    await settle();
    // Sending: never in the box and the timeline at once.
    expect(box(container).value).toBe("");
    expect(outgoing(container)).toContain("再看一下日志");
    expect(outgoing(container)).toContain("发送中…");
    expect(timeline(container)).not.toContain("再看一下日志");
    expect(button(container, "发送中…").disabled).toBe(true);

    // The user writes on while it is on its way.
    await type(container, "还有一件事");
    await respond(posts[0]!, ok("再看一下日志"));
    expect(timeline(container)).toContain("再看一下日志");
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("还有一件事");
    expect(button(container, "发送追问").disabled).toBe(false);
  });

  it("sends a comment once however often it is submitted", async () => {
    const { container } = await render();
    await type(container, "只发一次");
    await send(container);
    await send(container);
    await act(async () => {
      box(container).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    // Nor does a new draft go out while the first is on its way.
    await type(container, "第二条");
    await send(container);
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({ body: "只发一次" });
  });

  it("keeps a failed comment to retry beside a new draft", async () => {
    const { container } = await render();
    await type(container, "部署好了吗");
    await send(container);
    await settle();
    await type(container, "新的草稿");
    await respond(posts[0]!, failed());
    expect(outgoing(container)).toContain("部署好了吗");
    expect(outgoing(container)).toContain("未送达：任务已结束");
    expect(box(container).value).toBe("新的草稿");

    await act(async () => button(container, "重试").click());
    await settle();
    expect(outgoing(container)).toContain("发送中…");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual({ body: "部署好了吗" });
    await respond(posts[1]!, ok("部署好了吗"));
    expect(timeline(container)).toContain("部署好了吗");
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("新的草稿");
  });

  it("puts a failed comment back ahead of the draft to edit", async () => {
    const { container } = await render();
    await type(container, "第一句");
    await send(container);
    await settle();
    await type(container, "第二句");
    await respond(posts[0]!, failed());
    await act(async () => button(container, "编辑").click());
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("第一句\n第二句");
  });

  it("stops showing the comment as soon as a refresh has it", async () => {
    const { container, client } = await render();
    await type(container, "看看进度");
    await send(container);
    await settle();
    // The task polls; its comment can land before the response does.
    await act(async () =>
      client.setQueryData(["tasks", "t1"], commented(detail, "看看进度")),
    );
    await settle();
    expect(timeline(container)).toContain("看看进度");
    expect(outgoing(container)).toBeNull();
    // A late failure (the response was lost) changes nothing.
    await respond(posts[0]!, failed());
    expect(outgoing(container)).toBeNull();
  });

  it("says a pasted image stays out of the comment, and keeps the pasted text", async () => {
    const warn = rstest.spyOn(toast, "warning");
    const { container } = await render();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    const image = new File(["x"], "shot.png", { type: "image/png" });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [image, image], getData: () => "" },
    });
    await act(async () => box(container).dispatchEvent(paste));
    expect(warn).toHaveBeenCalledWith(
      "追问还不能带图片或文件，2 个没有加进来。",
    );
    expect(paste.defaultPrevented).toBe(false);
  });
});

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => () => {},
}));
