import type { BoardTaskDetail } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { toast } from "sonner";
import { setWire } from "@/lib/wire";
import { useTask } from "@/queries/tasks";
import { productHost, taskActivity, taskDetail } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { CommentBox, Timeline } from "./tasks";

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => () => {},
}));

const task = taskDetail({ id: "t1", title: "测试任务", status: "in_progress" });

/** The detail's timeline and its box, on the task's own target, as the views wire them. */
function Detail() {
  const { task } = useTask("t1");
  return task ? (
    <>
      <Timeline task={task} />
      <CommentBox task={task} />
    </>
  ) : null;
}

interface Call {
  args: { taskId: string; body: string };
  resolve: () => void;
  reject: (error: Error) => void;
}
let calls: Call[] = [];

/** A host whose comment calls wait for the test to answer them. */
async function render() {
  const host = productHost({ tasks: [{ task, activity: [] }] });
  host.handle(
    "tasks.comment",
    (args) =>
      new Promise((resolve, reject) =>
        calls.push({
          args: args as Call["args"],
          resolve: () => resolve({ task, activity: taskActivity({ id: "x" }) }),
          reject,
        }),
      ),
  );
  host.hello();
  const view = await mount(<Detail />);
  await flush();
  return { ...view, host };
}

/** The comment as the host would record it, pushed to everyone watching the task. */
const record = (host: ReturnType<typeof productHost>, ...bodies: string[]) =>
  act(async () => {
    host.set("tasks.t1", {
      task: { ...task, comments: bodies.length } satisfies BoardTaskDetail,
      activity: bodies.map((body, i) =>
        taskActivity({ id: `a${i + 1}`, body, createdAt: 2000 + i }),
      ),
    });
  });

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

describe("comments on a task", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    calls = [];
  });

  it("moves the comment out of the box when sent and into the timeline when it arrives", async () => {
    const { container, host } = await render();
    await type(container, "再看一下日志");
    await send(container);
    await flush();
    // Sending: never in the box and the timeline at once.
    expect(box(container).value).toBe("");
    expect(outgoing(container)).toContain("再看一下日志");
    expect(outgoing(container)).toContain("发送中…");
    expect(timeline(container)).not.toContain("再看一下日志");
    expect(button(container, "发送中…").disabled).toBe(true);

    // The user writes on while it is on its way.
    await type(container, "还有一件事");
    await record(host, "再看一下日志");
    await act(async () => calls[0]!.resolve());
    await flush();
    expect(timeline(container)).toContain("再看一下日志");
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("还有一件事");
    expect(button(container, "评论").disabled).toBe(false);
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
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual({ taskId: "t1", body: "只发一次" });
  });

  it("keeps a failed comment to retry beside a new draft", async () => {
    const { container, host } = await render();
    await type(container, "部署好了吗");
    await send(container);
    await flush();
    await type(container, "新的草稿");
    await act(async () => calls[0]!.reject(new Error("任务已结束")));
    await flush();
    expect(outgoing(container)).toContain("部署好了吗");
    expect(outgoing(container)).toContain("未送达：任务已结束");
    expect(box(container).value).toBe("新的草稿");

    await act(async () => button(container, "重试").click());
    await flush();
    expect(outgoing(container)).toContain("发送中…");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual({ taskId: "t1", body: "部署好了吗" });
    await record(host, "部署好了吗");
    await act(async () => calls[1]!.resolve());
    await flush();
    expect(timeline(container)).toContain("部署好了吗");
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("新的草稿");
  });

  it("puts a failed comment back ahead of the draft to edit", async () => {
    const { container } = await render();
    await type(container, "第一句");
    await send(container);
    await flush();
    await type(container, "第二句");
    await act(async () => calls[0]!.reject(new Error("任务已结束")));
    await flush();
    await act(async () => button(container, "编辑").click());
    expect(outgoing(container)).toBeNull();
    expect(box(container).value).toBe("第一句\n第二句");
  });

  it("stops showing the comment as soon as the task's push has it", async () => {
    const { container, host } = await render();
    await type(container, "看看进度");
    await send(container);
    await flush();
    // The comment can land as state before the reply does.
    await record(host, "看看进度");
    await flush();
    expect(timeline(container)).toContain("看看进度");
    expect(outgoing(container)).toBeNull();
    // A late failure (the reply was lost) changes nothing.
    await act(async () => calls[0]!.reject(new Error("连接断开")));
    await flush();
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
      "评论还不能带图片或文件，2 个没有加进来。",
    );
    expect(paste.defaultPrevented).toBe(false);
  });
});
