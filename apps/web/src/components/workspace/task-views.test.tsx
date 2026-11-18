import type { Task } from "@/queries/tasks";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { agentView, productHost, taskDetail } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";
import { useNewTask } from "./task-new-store";
import { board, release } from "./task-tree-fixture";
import { emptyFilter, useTaskView } from "./task-view";
import { useWorkspaceStore } from "./workspace-store";

const navigation = vi.hoisted(() => ({
  task: null as string | null,
  set: vi.fn(),
}));
vi.mock("./task-nav", () => ({
  useTaskNav: () => [navigation, navigation.set],
}));
const opened = vi.hoisted(() => ({ group: vi.fn() }));
const toasts = vi.hoisted(() => ({
  show: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: Object.assign(toasts.show, {
    error: toasts.error,
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));
vi.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => opened.group,
}));

/** The design's tree on a host: the parent is discussed in conversation c1. */
function host(tasks: Task[] = release()) {
  const h = productHost({
    agents: [
      agentView({ id: "ada", name: "Ada" }),
      agentView({ id: "bo", name: "Bo" }),
    ],
    tasks: tasks.map((task) => ({
      task: taskDetail({
        ...task,
        conversationId:
          task.conversationId ?? (task.number === 4 ? "c1" : null),
      }),
    })),
  });
  for (const action of ["addDependency", "removeDependency"])
    h.handle(`tasks.${action}`, (args) => ({
      task: taskDetail({ id: (args as { taskId: string }).taskId }),
    }));
  return h;
}

const card = (root: ParentNode, number: number) =>
  root.querySelector<HTMLElement>(`li[data-task="${number}"]`)!;

const cardNumbers = (root: ParentNode) =>
  [...root.querySelectorAll("section li[data-task]")].map((li) =>
    Number(li.getAttribute("data-task")),
  );

const view = (container: HTMLElement, name: string) =>
  click(
    [...container.querySelectorAll('[role="radio"]')].find(
      (b) => b.textContent === name,
    ),
  );

/** Type into a controlled input the way React hears it. */
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const callsOf = (h: ReturnType<typeof host>, action: string) =>
  h.calls.filter((c) => c.action === action).map((c) => c.args);

describe("the tasks page's views", () => {
  beforeEach(() => {
    useTaskView.setState({
      view: "board",
      grouping: "parent",
      filter: emptyFilter,
    });
  });
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    navigation.task = null;
    navigation.set.mockClear();
    opened.group.mockClear();
    toasts.show.mockClear();
    toasts.error.mockClear();
    localStorage.clear();
    useOutbox.setState({ drafts: {} });
    useNewTask.setState({ preset: undefined });
    useWorkspaceStore.setState({
      workspace: {},
      newConversation: { open: false },
    });
    Object.assign(window, { innerWidth: 1024 });
  });

  it("keeps the filter across the board, the list and the plan", async () => {
    host();
    const { container } = await mount(<TaskBoard />);
    await flush();
    await type(container.querySelector('input[type="search"]')!, "登录");
    expect(cardNumbers(container).sort()).toEqual([2, 3]);
    expect(container.querySelector("h1")!.textContent).toContain("2 / 10");

    await view(container, "列表");
    expect(
      [...container.querySelectorAll("#main li[data-task]")].map((li) =>
        li.getAttribute("data-task"),
      ),
    ).toEqual(["2", "3"]);

    await view(container, "计划");
    expect(
      [...container.querySelectorAll("[data-plan-node]")].map((n) =>
        n.getAttribute("data-task"),
      ),
    ).toEqual(["2", "3"]);

    await view(container, "看板");
    expect(cardNumbers(container).sort()).toEqual([2, 3]);
    expect(
      container.querySelector<HTMLInputElement>('input[type="search"]')!.value,
    ).toBe("登录");
  });

  it("narrows to a piece of work, and to an executor, in every view", async () => {
    host();
    useTaskView.setState({ filter: { q: "", who: null, under: "t4" } });
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(cardNumbers(container).sort((a, b) => a - b)).toEqual([
      4, 5, 6, 7, 8, 9,
    ]);
    await view(container, "计划");
    expect(container.querySelectorAll("[data-plan]")).toHaveLength(1);
    useTaskView.setState({ filter: { q: "", who: "bo", under: null } });
    await flush();
    expect(
      [...container.querySelectorAll("[data-plan-node]")].map((n) =>
        n.getAttribute("data-task"),
      ),
    ).toEqual(["11"]);
  });

  describe("the board", () => {
    it("names what a card waits for by its title, not its number", async () => {
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const waiting = card(container, 9);
      expect(waiting.hasAttribute("data-waiting")).toBe(true);
      expect(waiting.querySelector("[data-wait]")!.textContent).toBe(
        "等 跑回归测试 交付",
      );
      expect(card(container, 3).querySelector("[data-wait]")!.textContent).toBe(
        "等 实现登录接口 交付",
      );
      expect(waiting.querySelector("[data-wait]")!.textContent).not.toContain(
        "#",
      );
    });

    it("counts what a card waits for when it waits for several", async () => {
      const tasks = release();
      const nine = tasks.find((t) => t.number === 9)!;
      // #7 back to work: both are left now.
      const seven = tasks.find((t) => t.number === 7)!;
      seven.status = "in_progress";
      nine.dependsOn = nine.dependsOn!.map((e) => ({
        ...e,
        status: e.number === 7 ? "in_progress" : e.status,
        state: "waiting",
      }));
      nine.waitingOn = nine.dependsOn.map((e) => ({
        ...e,
        state: "waiting" as const,
        via: null,
      }));
      host(tasks);
      const { container } = await mount(<TaskBoard />);
      await flush();
      expect(card(container, 9).querySelector("[data-wait]")!.textContent).toBe(
        "等 2 个任务 · 还差 2 个",
      );
    });

    it("shows a parent's progress bar, what is going and the counts, and its subtasks under it", async () => {
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const parent = card(container, 4);
      expect(parent.hasAttribute("data-parent")).toBe(true);
      expect(parent.textContent).toContain("#4 · 5 个子任务");
      expect(
        parent.querySelector("[data-progress]")!.getAttribute("data-progress"),
      ).toBe("done done in_review in_progress waiting");
      expect(
        parent.querySelector('[role="img"]')!.getAttribute("aria-label"),
      ).toBe("2/5 完成");
      expect(parent.textContent).toContain("现在：跑回归测试 · 之后：发布公告");
      expect(parent.querySelector("[data-counts]")!.textContent).toBe(
        "2 完成 · 1 待验收 · 1 运行 · 1 等待",
      );
      expect(parent.querySelector('ul[aria-label="子任务"]')).toBeNull();
      await click(
        parent.querySelector('button[aria-label="展开 #4 的子任务"]'),
      );
      const children = parent.querySelector('ul[aria-label="子任务"]')!;
      expect(
        [...children.querySelectorAll("li")].map(
          (li) => li.textContent?.match(/#(\d+)/)?.[1],
        ),
      ).toEqual(["5", "6", "7", "8", "9"]);
    });

    it("says which piece of work a subtask is a step of", async () => {
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      expect(card(container, 9).textContent).toContain("发布 v1.0 › 第 3 步");
      expect(card(container, 8).textContent).toContain("发布 v1.0 › 第 2 步");
      expect(card(container, 2).textContent).not.toContain("›");
    });

    it("says what a card unlocks, or has let go", async () => {
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      expect(card(container, 8).textContent).toContain("解锁 1 个任务");
      expect(card(container, 7).textContent).toContain("已放行 1 个");
    });

    it("says why a blocked card is stuck and lets it start without waiting", async () => {
      const h = host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const blocked = card(container, 11);
      expect(blocked.className).toContain("border-l-state-error");
      expect(blocked.textContent).toContain("它等的「导出旧库快照」被取消了");
      await click(
        [...blocked.querySelectorAll("button")].find(
          (b) => b.textContent === "不等了，直接开始",
        ),
      );
      await flush();
      expect(callsOf(h, "removeDependency")).toEqual([
        { taskId: "t11", dependsOn: "t10" },
      ]);
      expect(
        [...blocked.querySelectorAll("button")].some(
          (b) => b.textContent === "换一个前置…",
        ),
      ).toBe(true);
    });

    it("offers as another prerequisite neither the cancelled one nor one it already waits for", async () => {
      // #11 waits for the cancelled #10 and for #2, which is still going.
      const tasks = release();
      const eleven = tasks.find((t) => t.number === 11)!;
      // The same edge #3 has onto #2.
      const onTwo = tasks.find((t) => t.number === 3)!.dependsOn![0]!;
      eleven.dependsOn = [...eleven.dependsOn!, onTwo];
      host(tasks);
      const { container } = await mount(<TaskBoard />);
      await flush();
      await click(
        [...card(container, 11).querySelectorAll("button")].find(
          (b) => b.textContent === "换一个前置…",
        ),
      );
      await flush();
      const offered = [...document.querySelectorAll("[cmdk-item]")].map(
        (i) => i.textContent ?? "",
      );
      expect(offered.some((o) => o.includes("接入前端登录页"))).toBe(true);
      expect(offered.some((o) => o.includes("导出旧库快照"))).toBe(false);
      expect(offered.some((o) => o.includes("实现登录接口"))).toBe(false);
    });

    it("unfolds the backlog when asked", async () => {
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      await click(
        container.querySelector('button[aria-label="展开「积压」列"]'),
      );
      expect(
        container
          .querySelector('section[aria-label="积压"]')!
          .hasAttribute("data-folded"),
      ).toBe(false);
    });

    it("shows one column at a time on a phone", async () => {
      Object.assign(window, { innerWidth: 390 });
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const track = container.querySelector("[data-swipe]")!;
      expect(track.children).toHaveLength(7);
      expect(track.className).toContain("snap-x");
      expect(
        container.querySelector('[aria-live="polite"]')!.textContent,
      ).toContain("进行中");
      await click(container.querySelector('button[aria-label="下一列"]'));
      expect(
        container.querySelector('[aria-live="polite"]')!.textContent,
      ).toContain("待验收");
    });
  });

  describe("the list", () => {
    it("groups the rows by the piece of work they belong to, with the rest on their own", async () => {
      host();
      useTaskView.setState({ view: "list" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const group = container.querySelector('li[data-group="4"]')!;
      expect(group.querySelector("[data-meta]")!.textContent).toBe(
        "#4 · 5 个子任务 · 2/5 完成",
      );
      expect(
        [...group.querySelectorAll("li[data-task]")].map((li) =>
          li.getAttribute("data-task"),
        ),
      ).toEqual(["5", "6", "7", "8", "9"]);
      const nine = group.querySelector('li[data-task="9"]')!;
      expect(nine.textContent).toContain("等「跑回归测试」交付");
      expect(nine.textContent).toContain("Ada");
      const loose = container.querySelector('li[data-group=""]')!;
      expect(loose.textContent).toContain("不属于任何一件事");
      expect(
        [...loose.querySelectorAll("li[data-task]")].map((li) =>
          li.getAttribute("data-task"),
        ),
      ).toEqual(["2", "3", "10", "11"]);
      expect(loose.querySelector('li[data-task="11"]')!.textContent).toContain(
        "它等的「导出旧库快照」被取消了",
      );
      await click(
        group.querySelector('button[aria-label="收起「发布 v1.0」"]'),
      );
      expect(group.querySelectorAll("li[data-task]")).toHaveLength(0);
    });
    it("shows a whole piece of work when only its parent matches, as the plan does", async () => {
      host();
      useTaskView.setState({
        view: "list",
        filter: { q: "v1.0", who: null, under: null },
      });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const group = container.querySelector('li[data-group="4"]')!;
      expect(
        [...group.querySelectorAll("li[data-task]")].map((li) =>
          li.getAttribute("data-task"),
        ),
      ).toEqual(["5", "6", "7", "8", "9"]);
    });
  });

  describe("the plan", () => {
    it("lays the work out in steps with the critical path heavier", async () => {
      host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const plan = container.querySelector('[data-plan="4"]')!;
      const steps = [...plan.querySelectorAll("ol > li")].map((li) => ({
        name: li.getAttribute("aria-label"),
        tasks: [...li.querySelectorAll("[data-plan-node]")].map((n) =>
          n.getAttribute("data-task"),
        ),
      }));
      expect(steps).toEqual([
        { name: "第 1 步", tasks: ["5", "6"] },
        { name: "第 2 步", tasks: ["7", "8"] },
        { name: "第 3 步", tasks: ["9"] },
      ]);
      expect(plan.textContent).toContain("2 / 2 完成");
      expect(plan.textContent).toContain("可并行");
      expect(plan.textContent).toContain("等第 2 步");
      expect(plan.textContent).toContain("#4 · 还差 2 步");
      expect(
        [...plan.querySelectorAll("[data-plan-node][data-critical]")].map((n) =>
          n.getAttribute("data-task"),
        ),
      ).toEqual(["5", "8", "9"]);
      expect(
        [...plan.querySelectorAll("g[data-edge][data-critical]")].map((g) =>
          g.getAttribute("data-edge"),
        ),
      ).toEqual(["t5>t8", "t8>t9"]);
      // The tasks of no piece of work, by their own edges.
      const loose = container.querySelector('[data-plan="loose"]')!;
      expect(
        [...loose.querySelectorAll("ol > li")].map(
          (li) => li.querySelectorAll("[data-plan-node]").length,
        ),
      ).toEqual([2, 1]);
    });

    /** Drag from one node's handle onto another, as the pointer does. */
    async function drag(container: HTMLElement, from: string, to: string) {
      const target = container.querySelector(`[data-plan-node="${to}"]`)!;
      const elementFromPoint = vi
        .spyOn(document, "elementFromPoint")
        .mockImplementation(() => target);
      const pointer = (type: string, x: number) =>
        Object.assign(
          new MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: 0,
            button: 0,
          }),
          {
            pointerId: 1,
          },
        );
      await act(async () => {
        container
          .querySelector(`[data-handle="${from}"]`)!
          .dispatchEvent(pointer("pointerdown", 0));
      });
      await act(async () => {
        window.dispatchEvent(pointer("pointermove", 80));
      });
      const line = container.querySelector("[data-drag-line]");
      const refused = line?.hasAttribute("data-refused") ?? false;
      await act(async () => {
        window.dispatchEvent(pointer("pointerup", 80));
      });
      await flush();
      elementFromPoint.mockRestore();
      return { drawn: line !== null, refused };
    }

    it("makes an edge by dragging from one task onto another", async () => {
      const h = host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const result = await drag(container, "t6", "t9");
      expect(result).toEqual({ drawn: true, refused: false });
      expect(callsOf(h, "addDependency")).toEqual([
        { taskId: "t9", dependsOn: "t6" },
      ]);
    });

    it("draws a drag that would close a cycle in red and does nothing on release", async () => {
      const h = host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      // #5 waiting for #9, which waits for #8, which waits for #5.
      const result = await drag(container, "t9", "t5");
      expect(result).toEqual({ drawn: true, refused: true });
      expect(callsOf(h, "addDependency")).toEqual([]);
      expect(toasts.error).toHaveBeenCalledTimes(1);
    });

    it("removes an edge, or makes it wait until done, from its menu", async () => {
      const h = host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const edge = container.querySelector('g[data-edge="t8>t9"]')!;
      await act(async () => {
        edge.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      const menu = container.querySelector(
        '[role="group"][aria-label="#9 等 #8"]',
      )!;
      await click(
        [...menu.querySelectorAll("button")].find(
          (b) => b.textContent === "改成等它完成",
        ),
      );
      await click(
        [...menu.querySelectorAll("button")].find(
          (b) => b.textContent === "删除",
        ),
      );
      await flush();
      expect(callsOf(h, "addDependency")).toEqual([
        { taskId: "t9", dependsOn: "t8", requireDone: true },
      ]);
      expect(callsOf(h, "removeDependency")).toEqual([
        { taskId: "t9", dependsOn: "t8" },
      ]);
    });

    it("opens an edge's menu from the keyboard: focus the edge, press Enter, land on its first action", async () => {
      useTaskView.setState({ view: "plan" });
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const edge = container.querySelector<SVGGElement>(
        'g[data-edge="t8>t9"]',
      )!;
      expect(edge.getAttribute("tabindex")).toBe("0");
      await act(async () => {
        edge.focus();
        edge.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      await act(async () => {
        edge.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      });
      await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      const menu = container.querySelector(
        '[role="group"][aria-label="#9 等 #8"]',
      )!;
      expect(menu).not.toBeNull();
      expect(document.activeElement).toBe(menu.querySelector("button"));
      expect(document.activeElement?.textContent).toBe("改成等它完成");
    });

    it('leaves an edge that is there alone when it is dragged again, keeping "until done"', async () => {
      // #9 waits for #8 until it is done; dragging #8 onto #9 again must not reset that.
      const tasks = release();
      const nine = tasks.find((t) => t.number === 9)!;
      nine.dependsOn = nine.dependsOn!.map((e) =>
        e.number === 8 ? { ...e, requireDone: true } : e,
      );
      const h = host(tasks);
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      expect(
        container
          .querySelector('g[data-edge="t8>t9"]')!
          .hasAttribute("data-require-done"),
      ).toBe(true);
      const result = await drag(container, "t8", "t9");
      expect(result.refused).toBe(false);
      expect(callsOf(h, "addDependency")).toEqual([]);
      // The hint that said so during the drag is gone on release; a toast says it instead, as
      // it does when the same edge is picked by clicks.
      expect(toasts.show).toHaveBeenCalledTimes(1);
      expect(toasts.show.mock.calls[0]![0]).toContain("#9 已经在等 #8 了");
      expect(
        container
          .querySelector('g[data-edge="t8>t9"]')!
          .hasAttribute("data-require-done"),
      ).toBe(true);
    });

    it("opens the form for a step that waits for every task of the last step", async () => {
      const tasks = board([
        { number: 1, title: "上线" },
        { number: 2, parent: 1 },
        { number: 3, title: "三", parent: 1, after: [2] },
        { number: 4, title: "四", parent: 1, after: [2] },
      ]);
      host(tasks);
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      await click(
        [...container.querySelectorAll('[data-plan="1"] button')].find(
          (b) => b.textContent === "在最后加一步",
        ),
      );
      expect(useNewTask.getState().preset).toEqual({
        parentId: "t1",
        dependsOn: [
          { id: "t3", requireDone: false },
          { id: "t4", requireDone: false },
        ],
      });
    });

    it("opens the form for a first step, waiting for nothing, when every subtask was cancelled", async () => {
      const tasks = board([
        { number: 1, title: "上线", status: "blocked" },
        { number: 2, parent: 1, status: "cancelled" },
        { number: 3, parent: 1, status: "cancelled" },
      ]);
      host(tasks);
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const plan = container.querySelector('[data-plan="1"]')!;
      expect(plan.querySelectorAll("[data-plan-node]")).toHaveLength(0);
      await click(
        [...plan.querySelectorAll("button")].find(
          (b) => b.textContent === "在最后加一步",
        ),
      );
      expect(useNewTask.getState().preset).toEqual({
        parentId: "t1",
        dependsOn: [],
      });
    });

    it("opens the new-task form for a last step: under the work, waiting for the last step", async () => {
      host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      await click(
        [...container.querySelectorAll('[data-plan="4"] button')].find(
          (b) => b.textContent === "在最后加一步",
        ),
      );
      await flush();
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog.textContent).toContain("发布 v1.0");
      expect(dialog.textContent).toContain("发布公告");
      expect(dialog.textContent).toContain("会排在第 4 步");
      expect(opened.group).not.toHaveBeenCalled();
    });

    it("stacks the steps on a phone, with no edges to drag", async () => {
      Object.assign(window, { innerWidth: 390 });
      host();
      useTaskView.setState({ view: "plan" });
      const { container } = await mount(<TaskBoard />);
      await flush();
      const plan = container.querySelector('[data-plan="4"]')!;
      expect(
        [...plan.querySelectorAll("h3")].map((h) => h.textContent),
      ).toEqual([
        "第 1 步 · 2 / 2 完成",
        "第 2 步 · 可并行",
        "第 3 步 · 等第 2 步",
      ]);
      expect(plan.querySelector("[data-handle]")).toBeNull();
      expect(plan.querySelector("g[data-edge]")).toBeNull();
    });

    it("opens a piece of work on its plan", async () => {
      navigation.task = "t4";
      host();
      const { container } = await mount(<TaskBoard />);
      await flush();
      const page = container.firstElementChild!.lastElementChild!;
      const modes = page.querySelector('[role="radiogroup"]')!;
      expect(
        [...modes.querySelectorAll('[role="radio"]')].map((b) => [
          b.textContent,
          b.getAttribute("aria-checked"),
        ]),
      ).toEqual([
        ["概览", "false"],
        ["计划", "true"],
      ]);
      expect(page.querySelectorAll("[data-plan-node]")).toHaveLength(5);
      await click(
        [...modes.querySelectorAll("button")].find(
          (b) => b.textContent === "概览",
        ),
      );
      expect(page.querySelectorAll("[data-plan-node]")).toHaveLength(0);
    });
  });
});
