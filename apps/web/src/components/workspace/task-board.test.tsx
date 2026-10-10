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
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskBoard />
      </QueryClientProvider>,
    ),
  );
  cleanup.push(() => {
    root.unmount();
    client.clear();
    container.remove();
  });
  return container;
}

describe("task board with a task open", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    navigation.task = null;
    navigation.set.mockClear();
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "list",
    }));
  });

  it("keeps the list beside the task from md, and leaves phones the task alone", async () => {
    navigation.task = "t1";
    const container = await render();
    const list = container.querySelector('section[aria-label="任务列表"]')!;
    // The list's column: hidden on phones, beside the task from md.
    const pane = list.parentElement!;
    expect(pane.className).toMatch(/(^| )hidden( |$)/);
    expect(pane.className).toContain("md:flex");
    // The task is the page's one main, and its row in the list is marked.
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(container.querySelector("main")!.textContent).toContain("任务说明");
    const current = list.querySelector('[aria-current="true"]')!;
    expect(current.textContent).toContain("测试任务");
    // Another row opens that task in place.
    const next = [...list.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("另一个任务"),
    )!;
    await act(async () => next.click());
    expect(navigation.set).toHaveBeenCalledWith({ task: "t2" });
  });

  it("shows the list beside a task even when the board layout is chosen", async () => {
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "board",
    }));
    navigation.task = "t1";
    const container = await render();
    const list = container.querySelector('section[aria-label="任务列表"]')!;
    expect(list.querySelector("ul li")?.textContent).toContain("测试任务");
    expect(useWorkspaceStore.getState().workspace.taskLayout).toBe("board");
  });

  it("is the whole page without a task", async () => {
    const container = await render();
    const main = container.querySelector("main#main")!;
    expect(main.parentElement!.className).not.toContain("hidden");
    expect(main.querySelector('[aria-current="true"]')).toBeNull();
  });
});
