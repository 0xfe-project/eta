import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { productHost, taskActivity, taskDetail } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { TaskBoard } from "./task-board";
import { queueReasonLabel } from "./task-format";

// The board shows what a task waits for, and gives a task a cancelled dependency blocked a way out.

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

const edge = (
  number: number,
  state: "resolved" | "waiting" | "cancelled",
  status: "todo" | "in_review" | "cancelled" = "todo",
) => ({
  taskId: `t${number}`,
  number,
  title: `T${number}`,
  status,
  requireDone: false,
  state,
});

function host() {
  const waiting = taskDetail({
    id: "t3",
    number: 3,
    title: "等别人的任务",
    status: "todo",
    runStatus: "queued",
    dependsOn: [edge(1, "resolved", "in_review"), edge(2, "waiting")],
    updatedAt: 3000,
  });
  const blocked = taskDetail({
    id: "t4",
    number: 4,
    title: "被卡住的任务",
    status: "blocked",
    dependsOn: [edge(5, "cancelled", "cancelled")],
    updatedAt: 2000,
  });
  const plain = taskDetail({
    id: "t6",
    number: 6,
    title: "老任务",
    updatedAt: 1000,
  });
  const h = productHost({
    tasks: [{ task: waiting }, { task: blocked }, { task: plain }],
  });
  h.handle("tasks.removeDependency", () => ({ task: blocked }));
  h.handle("tasks.update", () => ({ task: blocked }));
  h.hello();
  return h;
}

const card = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll("li")].find((li) =>
    li.textContent?.includes(title),
  )!;

describe("dependencies on the board", () => {
  afterEach(async () => {
    await cleanup();
    setWire(undefined);
  });

  it("says on a card which tasks it still waits for, and nothing on an old task", async () => {
    host();
    const { container } = await mount(<TaskBoard />);
    await flush();
    expect(card(container, "等别人的任务").textContent).toContain("等待 #2");
    expect(card(container, "等别人的任务").textContent).not.toContain("#1");
    expect(card(container, "老任务").textContent).not.toContain("等待");
    expect(card(container, "老任务").querySelector("[role=group]")).toBeNull();
  });

  it("offers a blocked card the way out: remove the cancelled dependency, or cancel", async () => {
    const h = host();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const blocked = card(container, "被卡住的任务");
    expect(blocked.textContent).toContain("依赖 #5 已取消");
    const buttons = [...blocked.querySelectorAll("[role=group] button")];
    expect(buttons.map((b) => b.textContent)).toEqual([
      "去掉依赖 #5",
      "取消本任务",
    ]);
    await click(buttons[0]!);
    expect(h.calls.find((c) => c.action === "removeDependency")?.args).toEqual({
      taskId: "t4",
      dependsOn: "t5",
    });
    await click(buttons[1]!);
    expect(h.calls.find((c) => c.action === "update")?.args).toEqual({
      taskId: "t4",
      status: "cancelled",
    });
  });

  it("folds a parent's subtasks under it in its column, and names the parent of one elsewhere", async () => {
    const parent = taskDetail({
      id: "p1",
      number: 10,
      title: "阶段一",
      status: "in_progress",
      subtasks: { total: 2, done: 0 },
      updatedAt: 900,
    });
    const working = taskDetail({
      id: "c1",
      number: 11,
      title: "子任务甲",
      status: "in_progress",
      parentId: "p1",
      updatedAt: 800,
    });
    const reviewing = taskDetail({
      id: "c2",
      number: 12,
      title: "子任务乙",
      status: "in_review",
      parentId: "p1",
      updatedAt: 700,
    });
    const h = productHost({
      tasks: [{ task: parent }, { task: working }, { task: reviewing }],
    });
    h.hello();
    const { container } = await mount(<TaskBoard />);
    await flush();
    const column = (label: string) =>
      container.querySelector(`section[aria-label="${label}"]`)!;
    const going = column("进行中");
    // One card at the top of the column: the subtask is folded under its parent.
    expect(going.querySelectorAll(":scope > ul > li")).toHaveLength(1);
    expect(going.textContent).toContain("子任务 0/2");
    expect(going.textContent).not.toContain("子任务甲");
    const toggle = going.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    )!;
    expect(toggle.getAttribute("aria-label")).toBe("展开 #10 的子任务");
    await click(toggle);
    expect(going.textContent).toContain("子任务甲");
    // In review, away from its parent: on its own, saying whose it is.
    expect(column("待验收").textContent).toContain("#10 阶段一 ›");
  });

  it("says the graph's history in the reader's language, and an old entry in its own words", async () => {
    const system = { kind: "system" as const, agentId: null };
    const blocked = taskDetail({
      id: "t4",
      number: 4,
      title: "被卡住的任务",
      status: "blocked",
      dependsOn: [edge(5, "cancelled", "cancelled")],
    });
    const h = productHost({
      tasks: [
        {
          task: blocked,
          activity: [
            taskActivity({
              id: "d1",
              kind: "dependency",
              body: null,
              data: {
                action: "added",
                taskId: "t5",
                number: 5,
                title: "T5",
                requireDone: true,
              },
            }),
            taskActivity({
              id: "d2",
              kind: "dependency",
              actor: system,
              body: null,
              data: { action: "blocked", taskId: "t5", number: 5, title: "T5" },
            }),
            // Written before the host left the words to its readers.
            taskActivity({
              id: "d3",
              kind: "dependency",
              actor: system,
              body: "Old words from the host.",
              data: {},
            }),
          ],
        },
      ],
    });
    h.hello();
    navigation.task = "t4";
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector("main")!;
    for (const fold of main.querySelectorAll<HTMLButtonElement>(
      "button[aria-expanded=false]",
    ))
      await click(fold);
    const text = main.textContent!;
    expect(text).toContain("开始等 #5 T5，只有它「已完成」才放行");
    expect(text).toContain("#5 T5 被取消了，本任务不会自己开始");
    expect(text).not.toMatch(/was cancelled|Waits for/);
    expect(text).toContain("Old words from the host.");
    navigation.task = null;
  });

  it("offers a parent no run, and says its status comes from its subtasks", async () => {
    const parent = taskDetail({
      id: "p1",
      number: 10,
      title: "阶段一",
      status: "in_progress",
      subtasks: { total: 2, done: 0 },
      // An agent's task: one that has an executor, and so a run row.
      createdBy: { kind: "agent", agentId: "a1" },
    });
    const child = taskDetail({
      id: "c1",
      number: 11,
      title: "子任务一",
      status: "in_progress",
      parentId: "p1",
    });
    const h = productHost({
      tasks: [
        {
          task: parent,
          activity: [
            taskActivity({
              id: "s1",
              kind: "subtask",
              body: null,
              data: {
                action: "added",
                taskId: "c1",
                number: 11,
                title: "子任务一",
              },
            }),
          ],
        },
        { task: child },
      ],
    });
    h.hello();
    navigation.task = "p1";
    const { container } = await mount(<TaskBoard />);
    await flush();
    const main = container.querySelector("main")!;
    expect(main.textContent).toContain("父任务不单独运行，状态由子任务推出");
    expect(main.textContent).not.toContain("还没运行过");
    const labels = [...main.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(labels).not.toContain("运行");
    expect(labels).not.toContain("从头重跑");
    for (const fold of main.querySelectorAll<HTMLButtonElement>(
      "button[aria-expanded=false]",
    ))
      await click(fold);
    expect(main.textContent).toContain("#11 子任务一 成为本任务的子任务");
    navigation.task = null;
  });

  it("names whom a queued run waits for", () => {
    expect(queueReasonLabel("waiting_deps", "m", [12, 13])).toBe(
      "等待 #12、#13",
    );
    expect(queueReasonLabel("machine_full", "m")).toContain("m");
    expect(queueReasonLabel("machine_offline", "m")).toContain("不在线");
  });
});
