import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
import { setWire } from "@/lib/wire";
import {
  agentView,
  buildProductHost,
  machineView,
  productHost,
  projectView,
  taskActivity,
  taskDetail,
} from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";
import { storageKey, useWorkspaceStore } from "./workspace-store";

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
  createdBy: { kind: "agent", agentId: "a1" },
  runStatus: "running",
  workspace: {
    mode: "worktree",
    base: null,
    path: "/data/worktrees/p1/task-1",
    branch: "eta/task-1",
  },
  runs: [
    {
      id: "r1",
      agentId: null,
      status: "running",
      queueReason: null,
      machineId: "m1",
      sessionId: "s1",
      continuesRunId: null,
      workspace: "/data/worktrees/p1/task-1",
      nudged: false,
      error: null,
      createdAt: 2500,
      startedAt: 2600,
      finishedAt: null,
    },
  ],
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
    agents: [agentView({ id: "a1", name: "小艾" })],
    tasks: [
      {
        task: first,
        activity: [
          taskActivity({ id: "a1", body: "好的" }),
          taskActivity({
            id: "a2",
            kind: "run_started",
            runId: "r1",
            actor: { kind: "system", agentId: null },
          }),
        ],
      },
      { task: second },
    ],
  });
  host.handle("tasks.update", (args) => ({
    task: { ...first, ...(args as object) },
  }));
  host.handle("tasks.interrupt", () => ({ task: first }));
  host.handle("tasks.rerun", () => ({ task: first, run: first.runs[0] }));
  host.hello();
  return host;
}

/** The board's pane: the page's first child, behind an open task. */
const boardPane = (container: HTMLElement) =>
  container.firstElementChild!.firstElementChild as HTMLElement;

describe("task board", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
    navigation.task = null;
    navigation.set.mockClear();
    localStorage.clear();
    useWorkspaceStore.setState({ workspace: {} });
  });

  it("opens on the board, with nothing to switch to", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    // A column for every status, empty or not.
    expect(main.querySelector('section[aria-label="进行中"]')).not.toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[aria-label="列表"]')).toBeNull();
    expect(container.querySelector('[aria-label="看板"]')).toBeNull();
  });

  it("opens on the board in a browser that saved the list", async () => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({ lastModel: "m1", taskLayout: "list" }),
    );
    await useWorkspaceStore.persist.rehydrate();
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    expect(main.querySelector('section[aria-label="进行中"]')).not.toBeNull();
    expect(useWorkspaceStore.getState().workspace).toEqual({ lastModel: "m1" });
  });

  it("says so when there are no tasks yet", async () => {
    productHost({ tasks: [] });
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(container.textContent).toContain("还没有任务");
    expect(container.querySelector("#main section")).toBeNull();
  });

  it("shows it is loading until the host has answered", async () => {
    buildProductHost({ tasks: [] }).install();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(container.querySelector('#main [role="status"]')).not.toBeNull();
    expect(container.querySelector("#main section")).toBeNull();
  });

  it("says so when the tasks cannot be read", async () => {
    productHost({ absent: ["tasks"] });
    const { container } = await mount(<TaskBoard />);
    await flush();
    const alert = container.querySelector('#main [role="alert"]')!;
    expect(alert.textContent).toContain("无法加载任务");
    expect(container.querySelector("#main section")).toBeNull();
  });

  it("sets the tasks out by status, in the board's own words", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    const columns = [...main.querySelectorAll("section")].map((s) => ({
      label: s.getAttribute("aria-label"),
      cards: [...s.querySelectorAll("li")].map((li) => li.textContent),
    }));
    expect(columns.map((c) => c.label)).toEqual([
      "积压",
      "待办",
      "进行中",
      "受阻",
      "待验收",
      "已完成",
    ]);
    expect(columns[1]!.cards[0]).toContain("#1");
    expect(columns[1]!.cards[0]).toContain("测试任务");
    expect(container.textContent).toContain("2");
  });

  it("shows the executor and the run of each task on its card", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const card = [...container.querySelectorAll("li")].find((li) =>
      li.textContent?.includes("测试任务"),
    )!;
    expect(card.textContent).toContain("小艾");
    expect(card.textContent).toContain("正在运行");
  });

  it("has no way to make a task: tasks are proposed by agents", async () => {
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(container.textContent).not.toContain("新建");
    expect(
      [...container.querySelectorAll("button")].filter((b) =>
        /新建|创建/.test(`${b.textContent}${b.getAttribute("aria-label")}`),
      ),
    ).toHaveLength(0);
    expect(host.calls.filter((c) => c.action === "create")).toHaveLength(0);
  });

  it("changes a task's status by dragging its card to a column", async () => {
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const card = container.querySelector<HTMLElement>("li button")!;
    const done = container.querySelector('section[aria-label="已完成"]')!;
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      get types() {
        return [...data.keys()];
      },
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
    };
    const drag = (target: Element, type: string) =>
      act(async () => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        target.dispatchEvent(Object.assign(event, { dataTransfer }));
      });
    await drag(card, "dragstart");
    await drag(done, "dragover");
    await drag(done, "drop");
    await flush();
    expect(host.calls.find((c) => c.action === "update")?.args).toEqual({
      taskId: "t1",
      status: "done",
    });
  });

  it("gives an open task the page, with the board out of the way", async () => {
    navigation.task = "t1";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    // The board takes no room and no focus; nothing is left to resize.
    const pane = boardPane(container);
    expect(pane.inert).toBe(true);
    expect(pane.className).toContain("invisible absolute inset-0");
    // The task is the page's one main.
    const main = container.querySelectorAll("main");
    expect(main).toHaveLength(1);
    expect(main[0]!.id).toBe("main");
    expect(main[0]!.textContent).toContain("任务说明");
    expect(main[0]!.textContent).toContain("好的");
    // The task's name in the header goes back to the board.
    const back = [...container.querySelectorAll("button")].find(
      (b) => !pane.contains(b) && b.textContent === "测试任务",
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

  it("lays an open task out as a document with its properties beside it", async () => {
    navigation.task = "t1";
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector("main")!;
    // The document holds the number, the title and the description as body text — not the first
    // message of a thread — then the activity.
    expect(main.textContent).toContain("#1");
    expect(main.textContent).toContain("测试任务");
    expect(main.textContent).toContain("任务说明");
    expect(main.textContent).toContain("动态");
    // The properties are a rail of their own, with the status that can change.
    const aside = container.querySelector('aside[aria-label="属性"]')!;
    expect(aside.textContent).not.toContain("任务说明");
    expect(aside.textContent).toContain("小艾");
    expect(aside.textContent).toContain("独立 worktree");
    expect(aside.textContent).toContain("eta/task-1");
    expect(aside.textContent).toContain("/data/worktrees/p1/task-1");
    // Nobody is assigned: the executor is whoever made the task.
    expect(aside.textContent).not.toContain("指派");
    const trigger = aside.querySelector<HTMLElement>('[role="combobox"]')!;
    await click(trigger);
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (option) => option.textContent === "受阻",
      ),
    );
    await flush();
    expect(
      host.calls.filter((c) => c.action === "update").map((c) => c.args),
    ).toEqual([{ taskId: "t1", status: "blocked" }]);
  });

  it("keeps the properties out of a narrow page until their button opens them", async () => {
    navigation.task = "t1";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const aside = container.querySelector("aside")!;
    // Closed, the rail does not take a column (`hidden`); the header button does.
    expect(aside.className.split(" ")).toContain("hidden");
    expect(aside.className).not.toContain("fixed");
    const open = container.querySelector<HTMLButtonElement>(
      'button[aria-controls="task-properties"]',
    )!;
    expect(open.className).toContain("@4xl:hidden");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    await click(open);
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(aside.className).toContain("fixed");
    expect(aside.className.split(" ")).not.toContain("hidden");
    // Still the same properties, status included.
    expect(aside.querySelector('[role="combobox"]')).not.toBeNull();
    await click(open);
    expect(aside.className.split(" ")).toContain("hidden");
  });

  it("stops the run that is going, from the timeline", async () => {
    navigation.task = "t1";
    const host = board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const stop = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "停止",
    )!;
    await click(stop);
    await flush();
    expect(host.calls.find((c) => c.action === "interrupt")?.args).toEqual({
      taskId: "t1",
      runId: "r1",
    });
  });

  it("offers a new run only when none is going, and asks for it", async () => {
    navigation.task = "t2";
    const host = board();
    host.set("tasks.t2", {
      task: taskDetail({
        id: "t2",
        number: 2,
        title: "另一个任务",
        status: "in_review",
        createdBy: { kind: "agent", agentId: "a1" },
        runStatus: "completed",
        runs: [{ ...first.runs[0]!, id: "r2", status: "completed" }],
      }),
      activity: [],
    });
    const { container } = await mount(<TaskBoard />);
    await flush();
    const rerun = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "从头重跑",
    )!;
    await click(rerun);
    await flush();
    expect(host.calls.find((c) => c.action === "rerun")?.args).toEqual({
      taskId: "t2",
    });
    // Its own words say what a comment would have done instead: carry on, not start over.
    expect(container.textContent).toContain("评论会让执行者接着上次往下做");
  });

  it("says what is going under the thread, not in it, with a way to stop it", async () => {
    navigation.task = "t2";
    const host = board();
    host.set("tasks.t2", {
      task: taskDetail({
        id: "t2",
        number: 2,
        title: "另一个任务",
        status: "in_progress",
        createdBy: { kind: "agent", agentId: "a1" },
        runStatus: "running",
        runs: [
          { ...first.runs[0]!, id: "r2", status: "completed" },
          {
            ...first.runs[0]!,
            id: "r3",
            status: "running",
            continuesRunId: "r2",
          },
        ],
      }),
      activity: [
        taskActivity({
          id: "a3",
          kind: "run_started",
          runId: "r3",
          actor: { kind: "system", agentId: null },
        }),
      ],
    });
    const { container } = await mount(<TaskBoard />);
    await flush();
    const live = container.querySelector('main [aria-label="进行中"]')!;
    expect(live.textContent).toContain("正在工作");
    expect(live.textContent).toContain("停止");
    // The thread folds the run's start into its bookkeeping.
    const timeline = container.querySelector('ol[aria-label="时间线"]')!;
    expect(timeline.textContent).not.toContain("停止");
  });

  it("names the machine a queued run waits for", async () => {
    navigation.task = "t1";
    const queued = (id: string, machineId: string) => ({
      ...first.runs[0]!,
      id,
      status: "queued" as const,
      queueReason: "machine_offline" as const,
      machineId,
      sessionId: null,
      workspace: null,
      startedAt: null,
    });
    productHost({
      agents: [agentView({ id: "a1", name: "小艾" })],
      machines: [
        machineView({
          id: "m2",
          kind: "daemon",
          name: "macbook",
          status: "offline",
        }),
      ],
      tasks: [
        {
          task: {
            ...first,
            runStatus: "queued",
            // The second is on a machine the page does not know: it says "this machine", as before.
            runs: [queued("r1", "m2"), queued("r2", "gone")],
          },
        },
      ],
    });
    const { container } = await mount(<TaskBoard />);
    await flush();
    const lines = [
      ...container.querySelectorAll('main [aria-label="进行中"] li'),
    ].map((li) => li.textContent);
    expect(lines[0]).toContain("小艾 排队中 · macbook 不在线，连上后开始");
    expect(lines[1]).toContain("这台机器 不在线");
  });

  /** t1, open; its project is on m1, and the executor's run works on `machineId`, in `workspace`. */
  function runOn(machineId: string, workspace: string) {
    navigation.task = "t1";
    const host = productHost({
      agents: [agentView({ id: "a1", name: "小艾" })],
      machines: [
        machineView({ id: "m1", name: "builder" }),
        machineView({ id: "m2", kind: "daemon", name: "macbook" }),
      ],
      projects: [projectView({ id: "p1", machineId: "m1" })],
      tasks: [
        {
          task: {
            ...first,
            projectId: "p1",
            runs: [{ ...first.runs[0]!, machineId, workspace }],
          },
        },
      ],
    });
    host.target("sessions.s1", {
      core: { session: "s1", running: true },
      transcript: { messages: [] },
    });
    host.handle("sessions.resync", () => ({}));
    host.hello();
  }

  /** The open task's properties, and what its run log's workspace button opens to. */
  async function workspaceAndLog() {
    const { container } = await mount(<TaskBoard />);
    await flush();
    const properties = container.querySelector("aside")!.textContent;
    await click(
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "执行记录",
      ),
    );
    await flush();
    const dialog = document.querySelector('[role="dialog"]')!;
    // The header is one line: the path is behind the workspace button, not under the title.
    expect(dialog.textContent).not.toContain("/");
    await click(dialog.querySelector('button[aria-label="工作区"]'));
    await flush();
    const log = document.querySelector(
      "[data-slot=popover-content]",
    )!.textContent;
    return { properties, log };
  }

  it("says a run on another machine than its project's works there, not in a worktree", async () => {
    runOn("m2", "/Users/me");
    const { properties, log } = await workspaceAndLog();
    expect(properties).toContain("在 macbook 上，不在项目里");
    expect(properties).toContain("/Users/me");
    // Nothing of the worktree the run never worked in.
    expect(properties).not.toContain("独立 worktree");
    expect(properties).not.toContain("eta/task-1");
    expect(log).toBe("机器macbook路径/Users/me复制路径");
  });

  it("says the worktree of a run on its project's machine, with no machine", async () => {
    runOn("m1", "/data/worktrees/p1/task-1");
    const { properties, log } = await workspaceAndLog();
    expect(properties).toContain("独立 worktree · eta/task-1");
    expect(properties).toContain("/data/worktrees/p1/task-1");
    expect(properties).not.toContain("builder");
    expect(log).toBe("分支eta/task-1路径/data/worktrees/p1/task-1复制路径");
  });

  it("draws a run's log from its session's transcript", async () => {
    navigation.task = "t1";
    const host = board();
    host.target("sessions.s1", {
      core: { session: "s1", running: true },
      transcript: {
        messages: [
          {
            entryId: "e1",
            message: {
              role: "user",
              content: [{ type: "text", text: "简报" }],
            },
          },
          {
            entryId: "e2",
            message: {
              role: "assistant",
              timestamp: 1,
              content: [
                { type: "text", text: "我先看看目录" },
                {
                  type: "toolCall",
                  id: "c1",
                  name: "bash",
                  arguments: { command: "ls" },
                },
              ],
            },
          },
          {
            entryId: "e3",
            message: {
              role: "toolResult",
              toolCallId: "c1",
              isError: false,
              content: [{ type: "text", text: "src" }],
            },
          },
        ],
      },
    });
    host.handle("sessions.resync", () => ({}));
    host.hello();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const log = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("执行记录"),
    )!;
    await click(log);
    await flush();
    // In a dialog, which is drawn over the page rather than inside the board.
    const text = document.querySelector('[aria-label="执行记录"]')!.textContent;
    expect(text).toContain("我先看看目录");
    expect(text).toContain("bash");
    // The briefing is the task itself, not a line of the log.
    expect(text).not.toContain("简报");
  });

  it("finds the board as it was left, scrolled where it was", async () => {
    board();
    const { container, show } = await mount(<TaskBoard />);
    await flush();
    const columns = container.querySelector<HTMLElement>(
      '[role="main"] > div',
    )!;
    columns.scrollLeft = 200;
    navigation.task = "t1";
    await show(<TaskBoard />);
    // Behind the task it is still there, not rendered anew on the way back.
    const pane = boardPane(container);
    expect(pane.contains(columns)).toBe(true);
    navigation.task = null;
    await show(<TaskBoard />);
    expect(pane.inert).toBe(false);
    expect(pane.className).not.toContain("invisible");
    expect(container.querySelector('[role="main"] > div')).toBe(columns);
    expect(columns.scrollLeft).toBe(200);
  });

  it("keeps the board behind a task", async () => {
    navigation.task = "t1";
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(
      boardPane(container).querySelector('section[aria-label="待办"]'),
    ).not.toBeNull();
  });

  it("is the whole page without a task, and a card opens its task", async () => {
    board();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector('[role="main"]#main')!;
    expect(boardPane(container).contains(main)).toBe(true);
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
    expect(
      container.querySelector('section[aria-label="待办"]')?.textContent,
    ).not.toContain("测试任务");
    expect(
      container.querySelector('section[aria-label="已完成"]')?.textContent,
    ).toContain("测试任务");
  });
});
