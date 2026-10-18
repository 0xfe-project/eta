import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { productHost, taskActivity, taskDetail } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({
  task: null as string | null,
  set: rstest.fn(),
}));
rstest.mock("./task-nav", () => ({
  useTaskNav: () => [navigation, navigation.set],
}));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => () => {},
}));

const first = taskDetail({
  id: "t1",
  number: 1,
  title: "测试任务",
  description: "任务说明",
  assignee: "user",
  updatedAt: 3000,
});
const second = taskDetail({
  id: "t2",
  number: 2,
  title: "另一个任务",
  status: "in_review",
  updatedAt: 2000,
});

function board() {
  const host = productHost({
    tasks: [
      { task: first, activity: [taskActivity({ id: "a1", body: "好的" })] },
      { task: second },
    ],
  });
  host.handle("tasks.update", (args) => ({
    task: { ...first, ...(args as object) },
  }));
  host.handle("tasks.create", (args) => ({
    task: { ...first, id: "t3", ...(args as object) },
  }));
  host.hello();
  return host;
}

/** The list's pane: the page's first child, behind an open task. */
const listPane = (container: HTMLElement) =>
  container.firstElementChild!.firstElementChild as HTMLElement;

describe("task board", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    navigation.task = null;
    navigation.set.mockClear();
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "list",
      taskScope: "all",
    }));
  });

  it("lists the board by status, in the board's own words", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    const sections = [...main.querySelectorAll("section")].map((s) => ({
      label: s.getAttribute("aria-label"),
      rows: [...s.querySelectorAll("li")].map((li) => li.textContent),
    }));
    expect(sections.map((s) => s.label)).toEqual(["待验收", "待办"]);
    expect(sections[1]!.rows[0]).toContain("#1");
    expect(sections[1]!.rows[0]).toContain("测试任务");
    expect(container.textContent).toContain("2");
  });

  it("narrows to the tasks that wait on the user, and back", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const mine = [...container.querySelectorAll('[role="tab"]')].find(
      (tab) => tab.textContent === "我的",
    )!;
    await act(async () => {
      mine.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      (mine as HTMLElement).click();
    });
    expect(useWorkspaceStore.getState().workspace.taskScope).toBe("user");
    expect(container.textContent).toContain("测试任务");
    expect(container.textContent).not.toContain("另一个任务");
  });

  it("changes a task's status from its row without opening it", async () => {
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const trigger = container.querySelector<HTMLElement>(
      'button[aria-label^="状态：待办"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const done = [...document.querySelectorAll('[role="menuitem"]')].find(
      (item) => item.textContent === "已完成",
    );
    await click(done);
    await flush();
    expect(host.calls.find((c) => c.action === "update")?.args).toEqual({
      taskId: "t1",
      status: "done",
    });
  });

  it("creates a task from the form and opens it", async () => {
    navigation.task = "new";
    const host = board();
    const { show } = await mount(<TaskBoard />);
    await flush();
    const title = document.querySelector<HTMLInputElement>("#task-title")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setter.call(title, "新任务");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = title.form!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
    expect(host.calls.find((c) => c.action === "create")?.args).toEqual({
      title: "新任务",
      description: "",
      status: "todo",
      assignee: "none",
    });
    expect(navigation.set).toHaveBeenCalledWith({ task: "t3" });
    await show(null);
  });

  it("gives an open task the page, with the list out of the way", async () => {
    navigation.task = "t1";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    // The list takes no room and no focus; nothing is left to resize.
    const pane = listPane(container);
    expect(pane.inert).toBe(true);
    expect(pane.className).toContain("invisible absolute inset-0");
    // The task is the page's one main.
    const main = container.querySelectorAll("main");
    expect(main).toHaveLength(1);
    expect(main[0]!.id).toBe("main");
    expect(main[0]!.textContent).toContain("任务说明");
    expect(main[0]!.textContent).toContain("好的");
    // 任务 goes back to the list.
    const back = [...container.querySelectorAll("button")].find(
      (b) => !pane.contains(b) && b.textContent === "任务",
    )!;
    await act(async () => back.click());
    expect(navigation.set).toHaveBeenCalledWith({ task: null });
  });

  it("says a task the board does not have is gone", async () => {
    navigation.task = "nope";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(container.querySelector("main")!.textContent).toContain(
      "这个任务已不存在",
    );
  });

  it("edits the status and the assignee of the open task", async () => {
    navigation.task = "t1";
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const triggers = container.querySelectorAll<HTMLElement>(
      'aside [role="combobox"]',
    );
    const choose = async (trigger: HTMLElement, text: string) => {
      await click(trigger);
      await click(
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
          (option) => option.textContent === text,
        ),
      );
    };
    await choose(triggers[0]!, "受阻");
    await choose(triggers[1]!, "未指派");
    await flush();
    expect(
      host.calls.filter((c) => c.action === "update").map((c) => c.args),
    ).toEqual([
      { taskId: "t1", status: "blocked" },
      { taskId: "t1", assignee: "none" },
    ]);
  });

  it("finds the list as it was left, at the task just open", async () => {
    board();
    const { container, show } = await mount(<TaskBoard />);
    await flush();
    navigation.task = "t1";
    await show(<TaskBoard />);
    navigation.task = null;
    await show(<TaskBoard />);
    const pane = listPane(container);
    expect(pane.inert).toBe(false);
    expect(pane.className).not.toContain("invisible");
    const current = container.querySelector<HTMLElement>(
      '[role="main"] [aria-current="true"]',
    )!;
    expect(current.textContent).toContain("测试任务");
    expect(document.activeElement).toBe(current);
  });

  it("keeps the board behind a task", async () => {
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "board",
    }));
    navigation.task = "t1";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(
      listPane(container).querySelector('section[aria-label="待办"]'),
    ).not.toBeNull();
    expect(useWorkspaceStore.getState().workspace.taskLayout).toBe("board");
  });

  it("is the whole page without a task, and a row opens its task", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    expect(listPane(container).contains(main)).toBe(true);
    expect(main.querySelector('[aria-current="true"]')).toBeNull();
    const next = [...main.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("另一个任务"),
    )!;
    await act(async () => next.click());
    expect(navigation.set).toHaveBeenCalledWith({ task: "t2" });
  });

  it("follows the host when a task moves, with no refresh", async () => {
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(
      container.querySelector('section[aria-label="待办"]')?.textContent,
    ).toContain("测试任务");
    await act(async () => {
      host.set("tasks", {
        list: [
          { ...first, status: "done" as const, updatedAt: 4000 },
          second,
        ].map(({ description: _d, artifacts: _a, ...listed }) => listed),
      });
    });
    expect(container.querySelector('section[aria-label="待办"]')).toBeNull();
    expect(
      container.querySelector('section[aria-label="已完成"]')?.textContent,
    ).toContain("测试任务");
  });
});
