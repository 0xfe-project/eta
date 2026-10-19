import type { GitHubPull, TaskPullView } from "@eta/client-contracts";
import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { button, cleanup, flush, mount } from "@/test-render";
import { DeliveredPull, TaskPulls } from "./task-pulls";

// A pull request a task delivered: its state and size on GitHub now, and merging it. These are the
// cases of the original task-pulls component, over the wire instead of the forge's REST.

const toasts = rstest.hoisted(() => ({
  message: rstest.fn(),
  success: rstest.fn(),
  error: rstest.fn(),
}));
rstest.mock("sonner", () => ({
  toast: Object.assign(toasts.message, {
    success: toasts.success,
    error: toasts.error,
  }),
}));

afterEach(async () => {
  await cleanup();
  setWire(undefined);
  rstest.restoreAllMocks();
  toasts.message.mockClear();
  toasts.success.mockClear();
  toasts.error.mockClear();
});

const url = "https://github.com/acme/web/pull/7";
const task = {
  id: "t1",
  number: 1,
  title: "任务",
  status: "in_review",
  assignee: "user",
} as unknown as TaskDetail;
const open: GitHubPull = {
  url,
  title: "Add web",
  state: "open",
  additions: 12,
  deletions: 3,
  headSha: "abc123",
  merge: "ready",
};
const merged: GitHubPull = {
  url,
  title: "Add web",
  state: "merged",
  additions: 12,
  deletions: 3,
  headSha: "abc123",
};

const text = () => document.body.textContent ?? "";
const returned = rstest.fn();

function host(
  handlers: {
    pull?: (args: unknown) => unknown;
    merge?: (args: unknown) => unknown;
    update?: (args: unknown) => unknown;
  },
  pulls: TaskPullView[] = [],
) {
  const fake = buildProductHost({}, ["github"]).target("github", {
    state: {},
    pulls,
  });
  fake.handle("github.pull", handlers.pull ?? (() => open));
  fake.handle("github.merge", handlers.merge ?? (() => merged));
  fake.handle("tasks.update", handlers.update ?? (() => ({})));
  fake.install();
  fake.hello();
  return fake;
}

async function render(status = task.status) {
  const view = await mount(
    <ul>
      <DeliveredPull
        task={{ ...task, status } as TaskDetail}
        url={url}
        title="acme/web#7"
        onDone={returned}
      />
    </ul>,
  );
  await flush();
  return view;
}

const openMenu = async () => {
  const trigger =
    button(document.body, "更多合并方式") ??
    document.querySelector<HTMLElement>('[aria-label="更多合并方式"]')!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};
const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === name,
  ) as HTMLElement | undefined;
const click = async (element: Element | null | undefined) => {
  await act(async () => {
    (element as HTMLElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

describe("a delivered pull request", () => {
  it("shows its state and the lines it adds and removes", async () => {
    host({});
    const { container } = await render();
    expect(container.textContent).toContain("打开");
    expect(container.querySelector(".text-success")?.textContent).toBe("+12");
    expect(container.querySelector(".text-destructive")?.textContent).toBe(
      "−3",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(button(container, "合并")?.disabled).toBe(false);
  });

  it("says when GitHub cannot be read, without numbers", async () => {
    host({
      pull: () => {
        throw new Error("暂时连不上 GitHub。");
      },
    });
    const { container } = await render();
    expect(container.textContent).toContain("状态暂不可用");
    expect(container.textContent).not.toMatch(/[+−]\d/);
    expect(button(container, "合并")).toBeUndefined();
  });

  it("cannot be merged when GitHub would refuse, and says why", async () => {
    host({
      pull: () => ({
        ...open,
        merge: "blocked",
        reason: "有冲突，需要先解决。",
      }),
    });
    const { container } = await render();
    expect(button(container, "合并")?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="更多合并方式"]',
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain("有冲突，需要先解决。");
  });

  it("merges at the head it shows, once, and leaves the task alone", async () => {
    const fake = host({});
    const { container } = await render();
    await act(async () => {
      button(container, "合并")!.click();
      button(container, "合并")?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const merges = fake.calls.filter((call) => call.action === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]!.args).toEqual({ url, headSha: "abc123" });
    expect(fake.calls.some((call) => call.target === "tasks")).toBe(false);
    expect(returned).not.toHaveBeenCalled();
    await flush(20);
    expect(toasts.success).toHaveBeenCalled();
  });

  it("merges and completes; a failed completion is retried without merging again", async () => {
    let merges = 0;
    let updates = 0;
    const fake = host({
      pull: () => (merges > 0 ? merged : open),
      merge: () => {
        merges += 1;
        return merged;
      },
      update: () => {
        updates += 1;
        if (updates === 1) throw new Error("数据库不可用");
        return {};
      },
    });
    const { container } = await render();
    await openMenu();
    await click(menuItem("合并并标记任务完成"));
    await flush(20);
    expect(merges).toBe(1);
    expect(updates).toBe(1);
    expect(fake.calls.find((call) => call.target === "tasks")!.args).toEqual({
      taskId: "t1",
      status: "done",
    });
    expect(container.textContent).toContain("PR 已合并，任务未完成");
    expect(returned).not.toHaveBeenCalled();

    await click(button(container, "标记任务完成"));
    await flush(20);
    expect(merges).toBe(1);
    expect(updates).toBe(2);
    expect(container.textContent).not.toContain("任务未完成");
    expect(returned).toHaveBeenCalledTimes(1);
    returned.mockClear();
  });

  it("keeps an actionable completion error and never reports success", async () => {
    host({
      pull: () => merged,
      update: () => {
        throw new Error("请稍后重试");
      },
    });
    const { container } = await render();
    await click(button(container, "标记任务完成"));
    await flush(20);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "请稍后重试",
    );
    expect(button(container, "标记任务完成")!.disabled).toBe(false);
    expect(returned).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
  });

  it("keeps the detail on merge failure with a visible error", async () => {
    host({
      merge: () => {
        throw new Error("请先解决冲突");
      },
    });
    const { container } = await render();
    await openMenu();
    await click(menuItem("合并并标记任务完成"));
    await flush(20);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "请先解决冲突",
    );
    expect(returned).not.toHaveBeenCalled();
  });

  it("says the result is unknown when a merge got no answer, and does not retry it", async () => {
    let reads = 0;
    const fake = host({
      pull: () => {
        reads += 1;
        return open;
      },
      // Never answered: the connection drops under the call.
      merge: () => new Promise(() => undefined),
    });
    const { container } = await render();
    expect(reads).toBe(1);
    await act(async () => {
      button(container, "合并")!.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    fake.socket.drop();
    await flush(20);
    expect(text()).toContain("没有得到合并结果");
    expect(fake.calls.filter((call) => call.action === "merge")).toHaveLength(
      1,
    );
  });
});

describe("the pull requests of a task", () => {
  it("are a row of its properties, and nothing when it has none", async () => {
    host({}, [
      {
        taskId: "t1",
        url,
        title: "Add web",
        number: 7,
        openedAt: 1,
      },
      {
        taskId: "other",
        url: "https://github.com/acme/web/pull/9",
        title: "Not mine",
        number: 9,
        openedAt: 2,
      },
    ]);
    const { container } = await mount(
      <dl>
        <TaskPulls task={task} />
      </dl>,
    );
    await flush();
    expect(container.textContent).toContain("交付");
    expect(container.textContent).toContain("Add web");
    expect(container.textContent).not.toContain("Not mine");
    await cleanup();
    setWire(undefined);

    host({}, []);
    const empty = await mount(
      <dl>
        <TaskPulls task={task} />
      </dl>,
    );
    await flush();
    expect(empty.container.textContent).toBe("");
  });
});
