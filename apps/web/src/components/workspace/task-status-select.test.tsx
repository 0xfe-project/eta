import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost, taskDetail } from "@/test-product";
import { cleanup, flush, mount } from "@/test-render";
import { TaskStatusControl } from "./task-status-select";

// A task's status where it is changed: a label in its colour that opens the seven, keyed 1–7, with
// what a cancel would do to the tasks that wait; a parent's is its subtasks' and only shows.

const edge = (
  number: number,
  state: "resolved" | "waiting" | "cancelled",
  status: "todo" | "backlog" | "in_progress" | "done" = "todo",
) => ({
  taskId: `t${number}`,
  number,
  title: `T${number}`,
  status,
  requireDone: false,
  state,
});

function host(task: TaskDetail) {
  const h = productHost({ tasks: [{ task }] });
  h.handle("tasks.update", () => ({ task }));
  h.hello();
  return h;
}

const detail = (fields: Partial<TaskDetail>): TaskDetail => ({
  ...taskDetail({ id: "t1", status: "in_progress", ...fields }),
  activity: [],
});

const press = (target: EventTarget, key: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const trigger = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>("button[data-status]")!;

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

const items = () => [
  ...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
];

describe("the status menu", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("is the current status's label, and opens the seven in two groups, keyed 1–7", async () => {
    const task = detail({});
    host(task);
    const { container } = await mount(<TaskStatusControl task={task} />);
    await flush();
    const button = trigger(container);
    expect(button.dataset.status).toBe("in_progress");
    expect(button.textContent).toBe("进行中");
    expect(button.className).toContain("text-state-info");
    expect(button.className).toContain("border-state-info");
    await press(button, "Enter");
    expect(
      items().map((item) => item.getAttribute("aria-keyshortcuts")),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(
      items().map((item) => item.firstElementChild?.nextSibling?.textContent),
    ).toEqual(["积压", "待办", "进行中", "待验收", "已完成", "受阻", "已取消"]);
    // The way through the work, a rule, then the two ways out of it.
    const separator = menu()!.querySelector('[role="separator"]')!;
    expect(separator.previousElementSibling?.textContent).toContain("已完成");
    expect(separator.nextElementSibling?.textContent).toContain("受阻");
    // The current one is checked, with no key of its own.
    const current = items()[2]!;
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(current.querySelector("kbd")).toBeNull();
    expect(items()[3]!.textContent).toContain(
      "做完了，等你看；依赖它的任务会被放行",
    );
  });

  it("moves the task with a digit, and leaves it alone for the status it is in", async () => {
    const task = detail({});
    const h = host(task);
    const { container } = await mount(<TaskStatusControl task={task} />);
    await flush();
    await press(trigger(container), "Enter");
    // The key it already has closes the menu and changes nothing.
    await press(menu()!, "3");
    await flush();
    expect(menu()).toBeNull();
    expect(h.calls.filter((c) => c.action === "update")).toEqual([]);
    await press(trigger(container), "Enter");
    await press(menu()!, "6");
    await flush();
    expect(menu()).toBeNull();
    expect(
      h.calls.filter((c) => c.action === "update").map((c) => c.args),
    ).toEqual([{ taskId: "t1", status: "blocked" }]);
    // 8 is no status: the menu stays.
    await press(trigger(container), "Enter");
    await press(menu()!, "8");
    expect(menu()).not.toBeNull();
  });

  it("says on Cancel how many waiting tasks it would block", async () => {
    const task = detail({
      dependents: [
        edge(2, "waiting"),
        edge(3, "waiting", "backlog"),
        // Already let through, already finished: a cancel blocks neither.
        edge(4, "resolved", "in_progress"),
        edge(5, "waiting", "done"),
      ],
    });
    host(task);
    const { container } = await mount(<TaskStatusControl task={task} />);
    await flush();
    await press(trigger(container), "Enter");
    expect(items().at(-1)!.textContent).toContain(
      "不做了；等它的 2 个任务会转为受阻",
    );
  });

  it("says only that it is dropped when nothing waits for it", async () => {
    const task = detail({ dependents: [] });
    host(task);
    const { container } = await mount(<TaskStatusControl task={task} />);
    await flush();
    await press(trigger(container), "Enter");
    const cancel = items().at(-1)!.textContent;
    expect(cancel).toContain("不做了");
    expect(cancel).not.toContain("受阻");
  });

  it("shows a parent's status as a label, Auto beside it, and no menu", async () => {
    const task = detail({
      subtasks: { total: 5, done: 2 },
      children: [1, 2, 3, 4, 5].map((n) => ({
        taskId: `c${n}`,
        number: 10 + n,
        title: `C${n}`,
        status: "todo" as const,
      })),
    });
    host(task);
    const { container } = await mount(<TaskStatusControl task={task} />);
    await flush();
    expect(container.querySelector("button")).toBeNull();
    const label = container.querySelector('[data-status="in_progress"]')!;
    expect(label.textContent).toBe("进行中");
    const auto = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "自动",
    )!;
    expect(auto.getAttribute("aria-description")).toBe("由 5 个子任务推出");
  });
});
