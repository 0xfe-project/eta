import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Task } from "@/queries/tasks";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  rstest,
} from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import { agentView, productHost, taskDetail } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";
import { FlowBar } from "./task-detail";
import { NewTaskDialog } from "./task-new";
import { useNewTask } from "./task-new-store";
import { TaskPickList } from "./task-picker";
import { contextRows, sideGroups } from "./task-side";
import { board, release } from "./task-tree-fixture";
import { emptyFilter, useTaskView } from "./task-view";
import { queueSentence, sentenceLead } from "./task-words";
import { Tasks } from "./tasks";

// A task's own page as the design's sections 05–07 have it (where it stands between what it waits
// for and what waits for it, why it has not started, why it is stuck, how far a piece of work is),
// the new-task form and its split (08), the one picker (09), and the side panel's groups (10).

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

/** The design's tree, with #12 (waits for #3) and the edges each page reads from its own side. */
function tree(): Task[] {
  return [
    ...release(),
    ...board([
      { number: 2, title: "实现登录接口", status: "in_progress" },
      { number: 12, title: "端到端冒烟测试", after: [2] },
    ])
      .filter((t) => t.number === 12)
      .map((t) => ({
        ...t,
        dependsOn: [
          {
            taskId: "t3",
            number: 3,
            title: "接入前端登录页",
            status: "todo" as const,
            requireDone: false,
            state: "waiting" as const,
          },
        ],
        waitingOn: [
          {
            taskId: "t3",
            number: 3,
            title: "接入前端登录页",
            status: "todo" as const,
            state: "waiting" as const,
            via: null,
          },
        ],
      })),
  ];
}

/** Each task's detail as the host sends it: its dependents, its children, a run if it is going. */
function details(
  tasks: Task[],
  extra: Record<string, Partial<BoardTaskDetail>> = {},
) {
  return tasks.map((task) => ({
    task: taskDetail({
      ...task,
      dependents: tasks.flatMap((other) =>
        (other.dependsOn ?? [])
          .filter((e) => e.taskId === task.id)
          .map((e) => ({
            taskId: other.id,
            number: other.number,
            title: other.title,
            status: other.status,
            requireDone: e.requireDone,
            state: e.state,
          })),
      ),
      children: tasks
        .filter((c) => c.parentId === task.id)
        .map((c) => ({
          taskId: c.id,
          number: c.number,
          title: c.title,
          status: c.status,
        })),
      ...extra[task.id],
    }),
  }));
}

function host(
  tasks: Task[] = tree(),
  extra: Record<string, Partial<BoardTaskDetail>> = {},
) {
  const h = productHost({
    agents: [
      agentView({ id: "ada", name: "Ada" }),
      agentView({ id: "bo", name: "Bo" }),
    ],
    tasks: details(tasks, extra),
  });
  for (const action of ["addDependency", "removeDependency", "update"])
    h.handle(`tasks.${action}`, (args) => ({
      task: taskDetail({ id: (args as { taskId: string }).taskId }),
    }));
  h.handle("tasks.create", () => ({ tasks: [taskDetail({ id: "new" })] }));
  return h;
}

const callsOf = (h: ReturnType<typeof host>, action: string) =>
  h.calls.filter((c) => c.action === action).map((c) => c.args);

const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === text);

/** Type into a controlled field the way React hears it. */
async function type(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Pick an option of the open picker by its title. */
async function pick(title: string) {
  const item = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
    (i) => i.textContent?.includes(title),
  );
  expect(item).toBeDefined();
  await click(item);
  await flush();
}

const page = async (id: string) => {
  navigation.task = id;
  const { container } = await mount(<TaskBoard />);
  await flush();
  return container;
};

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
  useNewTask.setState({ preset: undefined });
  localStorage.clear();
});

describe("waiting for prerequisites (05)", () => {
  it("draws before → this task → after, every node by its whole title and where it stands", async () => {
    host();
    const container = await page("t3");
    const flow = container.querySelector<HTMLElement>("[data-flow]")!;
    expect(flow.getAttribute("data-flow")).toBe("row");
    const groups = [...flow.querySelectorAll("section")].map((s) =>
      [...s.querySelectorAll("li")].map((li) => li.textContent),
    );
    expect(groups).toEqual([
      ["实现登录接口运行中"],
      ["端到端冒烟测试等本任务"],
    ]);
    expect(flow.textContent).toContain("本任务还差 1 个");
  });

  it("stacks the flow into two groups on a phone", async () => {
    const tasks = tree();
    const three = details(tasks).find((d) => d.task.id === "t3")!.task;
    productHost({ tasks: details(tasks) });
    const { container } = await mount(
      <FlowBar task={{ ...three, activity: [] }} phone />,
    );
    const flow = container.querySelector("[data-flow]")!;
    expect(flow.getAttribute("data-flow")).toBe("column");
    expect([...flow.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "前置 · 1",
      "后续 · 1",
    ]);
  });

  it("says why it has not started as one sentence, with who starts it and from which branch", async () => {
    const h = host(tree(), {
      t3: {
        assigneeAgentId: "ada",
        workspace: {
          mode: "worktree",
          base: "eta/task-2",
          path: null,
          branch: null,
        },
      },
    });
    const container = await page("t3");
    const queue = container.querySelector<HTMLElement>("[data-queue]")!;
    expect(queue.textContent).toContain(
      "还不能开始：在等「实现登录接口」交付。它一进入待验收，Ada 就会自动开始这个任务，并从它的分支接着做。",
    );
    // Delivery is what it waits for already: pressing it sends nothing.
    await click(buttonIn(queue, "等交付即可"));
    expect(callsOf(h, "addDependency")).toEqual([]);
    await click(buttonIn(queue, "改成等它完成"));
    expect(callsOf(h, "addDependency")).toEqual([
      { taskId: "t3", dependsOn: "t2", requireDone: true },
    ]);
    await click(buttonIn(queue, "不等了，现在开始"));
    expect(callsOf(h, "removeDependency")).toEqual([
      { taskId: "t3", dependsOn: "t2" },
    ]);
    // The rail: queued for prerequisites, and where its worktree starts.
    const rail = container.querySelector("aside")!.textContent;
    expect(rail).toContain("等前置");
    expect(rail).toContain("从「实现登录接口」的分支开始");
  });

  it("says how many it waits for and which are left, and a full machine with how many it runs", () => {
    const tasks = board([
      { number: 1, title: "A", status: "in_progress" },
      { number: 2, title: "B", status: "todo" },
      { number: 3, title: "C", status: "in_review" },
      { number: 4, after: [1, 2, 3] },
      { number: 5 },
    ]);
    const four = tasks.find((t) => t.number === 4)!;
    expect(queueSentence(four, tasks, "Ada")).toBe(
      "还不能开始：在等 3 个任务，还差「A」「B」",
    );
    const one = board([
      { number: 1, title: "A" },
      { number: 2, after: [1] },
    ]);
    expect(queueSentence(one[1]!, one, "Ada")).toBe(
      "还不能开始：在等「A」交付。它一进入待验收，Ada 就会自动开始这个任务。",
    );
    const full = {
      reason: "machine_full" as const,
      name: "gpu-box",
      max: 2,
    };
    expect(queueSentence(tasks[4]!, tasks, "Ada", full)).toBe(
      "在等空位：gpu-box 上已有 2 个在跑",
    );
    const ready = board([
      { number: 1, status: "done" },
      { number: 2, after: [1] },
    ]);
    expect(queueSentence(ready[1]!, ready, "Ada", full)).toBe(
      "前置都好了，在等空位：gpu-box 上已有 2 个在跑",
    );
    expect(queueSentence(tasks[4]!, tasks, "Ada")).toBeUndefined();
  });
});

describe("the queue sentence's bold lead", () => {
  it('ends at the colon, full-width in Chinese and ": " in English', () => {
    expect(sentenceLead("还不能开始：在等「A」交付。")).toBe("还不能开始：");
    expect(
      sentenceLead("Can’t start yet: waiting for “A” to be delivered."),
    ).toBe("Can’t start yet: ");
    expect(sentenceLead("waiting for room: gpu-box already runs 2")).toBe(
      "waiting for room: ",
    );
    // A colon inside a word (a time, a URL) is not a lead.
    expect(sentenceLead("Starts at 12:30")).toBeUndefined();
    expect(sentenceLead("在等空位")).toBeUndefined();
  });
});

describe("a piece of work (06)", () => {
  it("shows its progress in three columns, its subtasks by step, and its status as read-only", async () => {
    host(tree(), { t4: { subtasks: { total: 5, done: 2 } } });
    const container = await page("t4");
    await click(
      [...container.querySelectorAll('[role="radio"]')].find(
        (b) => b.textContent === "概览",
      ),
    );
    const card = container.querySelector<HTMLElement>("[data-progress-card]")!;
    expect(card.textContent).toContain("2 / 5 完成 · 父任务自己不执行");
    const columns = [...card.querySelectorAll("section")].map((s) => [
      s.getAttribute("aria-label"),
      [...s.querySelectorAll("li")].map((li) =>
        li.textContent!.replace(/运行.*$|\d+ 分钟$/, ""),
      ),
    ]);
    expect(columns).toEqual([
      ["已完成", ["整理变更日志", "更新用户文档"]],
      ["现在", ["打包桌面安装包去验收", "跑回归测试"]],
      ["之后", ["发布公告"]],
    ]);
    const subtasks = container.querySelector(
      '[aria-labelledby="task-subtasks"]',
    )!;
    expect(
      [...subtasks.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual([
      "#5整理变更日志第 1 步",
      "#6更新用户文档第 1 步",
      "#7打包桌面安装包第 2 步",
      "#8跑回归测试第 2 步",
      "#9发布公告第 3 步",
    ]);
    // Read-only: a label with "Auto", no menu to open.
    const rail = container.querySelector("aside")!;
    expect(rail.textContent).toContain("自动");
    expect(rail.querySelector("button[data-status]")).toBeNull();
    expect(rail.textContent).toContain("由 5 个子任务推进");
    // No run is going: the comment box says where to change a step.
    expect(container.textContent).toContain(
      "在这里讨论；要改某一步，请在那个子任务里说",
    );
    await click(buttonIn(subtasks, "拆出一个"));
    expect(useNewTask.getState().preset).toEqual({ parentId: "t4" });
  });
});

describe("stuck (07)", () => {
  it("puts a red banner under the title, with the four ways on", async () => {
    const h = host(tree(), { t11: { assigneeAgentId: "bo" } });
    const container = await page("t11");
    const banner = container.querySelector<HTMLElement>("[data-stuck]")!;
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain("这个任务卡住了，需要你决定");
    expect(banner.textContent).toContain("它等的「导出旧库快照」（#10）");
    expect(banner.textContent).toContain("所以 Bo 不会自动开始它");

    await click(buttonIn(banner, "不等了，现在开始"));
    expect(callsOf(h, "removeDependency")).toEqual([
      { taskId: "t11", dependsOn: "t10" },
    ]);

    await click(buttonIn(banner, "换成等另一个任务…"));
    await flush();
    await pick("实现登录接口");
    expect(callsOf(h, "addDependency")).toEqual([
      { taskId: "t11", dependsOn: "t2", requireDone: false },
    ]);
    // Waiting for the new one, it drops the cancelled one.
    expect(callsOf(h, "removeDependency")).toHaveLength(2);

    await click(buttonIn(banner, "取消这个任务"));
    expect(callsOf(h, "update")).toEqual([
      { taskId: "t11", status: "cancelled" },
    ]);

    await click(buttonIn(banner, "去看 #10 为什么被取消"));
    expect(navigation.set).toHaveBeenCalledWith({ task: "t10" });
  });

  it("sends a piece of work whose subtasks were all cancelled to split out new ones", async () => {
    const tasks = board([
      { number: 1, title: "上线", status: "blocked" },
      { number: 2, parent: 1, status: "cancelled" },
    ]);
    host(tasks);
    const container = await page("t1");
    await click(
      [...container.querySelectorAll('[role="radio"]')].find(
        (b) => b.textContent === "概览",
      ),
    );
    const banner = container.querySelector<HTMLElement>("[data-stuck]")!;
    expect(banner.textContent).toContain("子任务全部取消了");
    await click(buttonIn(banner, "拆出一个子任务"));
    expect(useNewTask.getState().preset).toEqual({ parentId: "t1" });
  });
});

describe("a blocked card with nothing of its own to change", () => {
  it("offers the way to where it is dealt with: its parent, or the piece of work itself", async () => {
    const tasks = board([
      { number: 1, title: "上线", status: "blocked" },
      { number: 2, parent: 1, status: "cancelled" },
      { number: 3, title: "旧数据", status: "cancelled" },
      { number: 4, title: "迁移", status: "blocked", after: [3] },
      { number: 5, title: "迁移一步", status: "blocked", parent: 4 },
    ]);
    host(tasks);
    const { container } = await mount(<TaskBoard />);
    await flush();
    const exits = [
      ...container.querySelectorAll('[aria-label="接下来怎么办"]'),
    ].map((g) => [...g.querySelectorAll("button")].map((b) => b.textContent));
    expect(exits).toContainEqual(["去处理"]);
    expect(exits).toContainEqual(["去 #4 处理"]);
  });
});

describe("the new-task form (08)", () => {
  it("makes a task under a piece of work, waiting for what it is given, in one call", async () => {
    const h = host();
    await mount(<NewTaskDialog />);
    await act(async () => useNewTask.getState().open());
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await type(
      dialog.querySelector('input[aria-label="标题"]')!,
      "端到端冒烟测试",
    );
    await click(buttonIn(dialog, "选一件事"));
    await flush();
    // As a parent, only what can be one: not cancelled.
    expect(
      [...document.querySelectorAll("[cmdk-item]")].some((i) =>
        i.textContent?.includes("导出旧库快照"),
      ),
    ).toBe(false);
    await pick("发布 v1.0");
    expect(dialog.textContent).toContain("· 会排在第 1 步");
    await click(buttonIn(dialog, "添加"));
    await flush();
    await pick("跑回归测试");
    expect(dialog.textContent).toContain("· 会排在第 3 步");
    await act(async () => {
      dialog
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    await flush();
    expect(callsOf(h, "create")).toEqual([
      {
        tasks: [
          {
            title: "端到端冒烟测试",
            description: "",
            assignee: "ada",
            dependsOn: [{ task: "t8", requireDone: false }],
          },
        ],
        status: "todo",
        parent: "t4",
      },
    ]);
    expect(navigation.set).toHaveBeenCalledWith({ task: "new" });
  });

  it("splits a piece of work: lines, an arrow chain and side by side, previewed by step, sent at once", async () => {
    const h = host();
    await mount(<NewTaskDialog />);
    await act(async () =>
      useNewTask.getState().open({ parentId: "t4", split: true }),
    );
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("拆成子任务 · 发布 v1.0");
    await type(
      dialog.querySelector('textarea[aria-label="拆成子任务"]')!,
      "整理变更日志\n更新用户文档\n→ 跑回归测试\n→ 发布公告",
    );
    expect(dialog.querySelector("#split-preview")!.textContent).toBe(
      "预览：第 1 步 2 个（并行） · 第 2 步 1 个 · 第 3 步 1 个",
    );
    await click(buttonIn(dialog, "先放积压"));
    await click(buttonIn(dialog, "创建 4 个子任务"));
    await flush();
    expect(callsOf(h, "create")).toEqual([
      {
        tasks: [
          { title: "整理变更日志", assignee: "ada" },
          { title: "更新用户文档", assignee: "ada" },
          { title: "跑回归测试", assignee: "ada", after: [0, 1] },
          { title: "发布公告", assignee: "ada", after: [2] },
        ],
        status: "backlog",
        parent: "t4",
      },
    ]);
  });
});

describe("the picker (09)", () => {
  it("greys what would close a cycle, saying so, and keeps a parent's own work out of its parents", async () => {
    host();
    const picked = rstest.fn();
    await mount(
      <TaskPickList
        mode="dependsOn"
        subject={{ id: "t3", parentId: null }}
        projectId={undefined}
        onPick={picked}
      />,
    );
    await flush();
    const twelve = [
      ...document.querySelectorAll<HTMLElement>("[cmdk-item]"),
    ].find((i) => i.textContent?.includes("端到端冒烟测试"))!;
    expect(twelve.getAttribute("data-refusal")).toBe("cycle");
    expect(twelve.getAttribute("aria-disabled")).toBe("true");
    expect(twelve.textContent).toContain("它在等本任务，会成环");
    await click(twelve);
    expect(picked).not.toHaveBeenCalled();
    // When does it let this one go: two answers, each said.
    expect(document.body.textContent).toContain("它交付了就行");
    expect(document.body.textContent).toContain("你标成完成之后才开始");
    await cleanup();

    host();
    await mount(
      <TaskPickList
        mode="parent"
        subject={{ id: "t4", parentId: null }}
        projectId={undefined}
        onPick={picked}
      />,
    );
    await flush();
    const offered = [...document.querySelectorAll("[cmdk-item]")].map(
      (i) => i.textContent,
    );
    for (const under of ["整理变更日志", "跑回归测试", "发布公告"])
      expect(offered.some((o) => o?.includes(under))).toBe(false);
    expect(offered.some((o) => o?.includes("实现登录接口"))).toBe(true);
  });
});

describe("the side panel (10)", () => {
  it("groups the task tab as needs you, going, waiting, the most urgent first", async () => {
    const all = tree();
    const groups = sideGroups(all);
    expect(groups.needYou.map((t) => t.number)).toEqual([11, 7]);
    expect(groups.going.map((t) => t.number).sort((a, b) => a - b)).toEqual([
      2, 4, 8,
    ]);
    expect(groups.waiting.map((t) => t.number).sort((a, b) => a - b)).toEqual([
      3, 9, 12,
    ]);
    host();
    const { container } = await mount(<Tasks />);
    await flush();
    expect(
      [...container.querySelectorAll("[data-side-group]")].map((s) =>
        s.getAttribute("data-side-group"),
      ),
    ).toEqual(["needYou", "going", "waiting"]);
    const needYou = container.querySelector('[data-side-group="needYou"]')!;
    expect(needYou.querySelector("h3")!.textContent).toBe("需要你2");
  });

  it("lists a piece of work with its subtasks going on under it in the context tab", () => {
    const all = tree();
    const open = all.filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    );
    const rows = contextRows(open, all).map((r) => [r.task.number, r.depth]);
    expect(rows.slice(0, 3)).toEqual([
      [4, 0],
      [7, 1],
      [8, 1],
    ]);
    // A subtask that only waits is in its parent's bar, not a row.
    expect(rows.some(([n]) => n === 9)).toBe(false);
  });
});
