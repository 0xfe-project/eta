import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskBoard } from "./task-board";
import { useWorkspaceStore } from "./workspace-store";

const navigation = rstest.hoisted(() => ({
  task: null as string | null,
  set: rstest.fn(),
}));
rstest.mock("./task-nav", () => ({
  useTaskNav: () => [navigation, navigation.set],
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "t1",
  number: 1,
  title: "测试任务",
  status: "todo",
  assignee: { kind: "user" },
  comments: 0,
  run_status: null,
  updated_at: new Date().toISOString(),
};
const other = { ...task, id: "t2", number: 2, title: "另一个任务" };
const detail = {
  ...task,
  description: "任务说明",
  created_by: { kind: "user" },
  created_at: task.updated_at,
  activity: [],
  runs: [],
  assists: [],
  loops: [],
};

const cleanup: (() => void)[] = [];
async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["tasks"], { tasks: [task, other], assignees: [] });
  client.setQueryData(["tasks", "t1"], detail);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const draw = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <TaskBoard />
        </QueryClientProvider>,
      ),
    );
  await draw();
  cleanup.push(() => {
    root.unmount();
    client.clear();
    container.remove();
  });
  return { container, rerender: draw };
}

/** The list's pane: the page's first child, behind an open task. */
const listPane = (container: HTMLElement) =>
  container.firstElementChild!.firstElementChild as HTMLElement;

describe("task board", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    navigation.task = null;
    navigation.set.mockClear();
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "list",
    }));
  });

  it("gives an open task the page, with the list out of the way", async () => {
    navigation.task = "t1";
    const { container } = await render();
    // The list takes no room and no focus; nothing is left to resize.
    const pane = listPane(container);
    expect(pane.inert).toBe(true);
    expect(pane.className).toContain("invisible absolute inset-0");
    expect(container.querySelector('[role="separator"]')).toBeNull();
    // The task is the page's one main.
    const main = container.querySelectorAll("main");
    expect(main).toHaveLength(1);
    expect(main[0]!.id).toBe("main");
    expect(main[0]!.textContent).toContain("任务说明");
    // 任务 goes back to the list.
    const back = [...container.querySelectorAll("button")].find(
      (b) => !pane.contains(b) && b.textContent === "任务",
    )!;
    await act(async () => back.click());
    expect(navigation.set).toHaveBeenCalledWith({ task: null });
  });

  it("finds the list as it was left, at the task just open", async () => {
    const { container, rerender } = await render();
    navigation.task = "t1";
    await rerender();
    navigation.task = null;
    await rerender();
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
    const { container } = await render();
    expect(
      listPane(container).querySelector('section[aria-label="待办"]'),
    ).not.toBeNull();
    expect(useWorkspaceStore.getState().workspace.taskLayout).toBe("board");
  });

  it("is the whole page without a task", async () => {
    const { container } = await render();
    const main = container.querySelector('[role="main"]#main')!;
    expect(listPane(container).contains(main)).toBe(true);
    expect(main.querySelector('[aria-current="true"]')).toBeNull();
    // Another row opens that task in place.
    const next = [...main.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("另一个任务"),
    )!;
    await act(async () => next.click());
    expect(navigation.set).toHaveBeenCalledWith({ task: "t2" });
  });
});

rstest.mock("./use-groups", () => ({
  useGroups: () => ({ groups: [], current: undefined, groupId: null }),
  useOpenGroup: () => () => {},
}));
