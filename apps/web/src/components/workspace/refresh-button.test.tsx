import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { RoutineBoard } from "./routine-board";
import { TaskBoard } from "./task-board";
import { WorkspacePanel } from "./workspace-panel";
import { useWorkspaceStore } from "./workspace-store";

rstest.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

const navigation = rstest.hoisted(() => ({
  task: null as string | null,
  routine: null as string | null,
  run: null as string | null,
  edit: null as string | null,
  set: rstest.fn(),
}));
rstest.mock("./task-nav", () => ({
  useTaskNav: () => [navigation, navigation.set],
}));
rstest.mock("./routine-nav", () => ({
  useRoutineNav: () => [navigation, navigation.set],
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
const detail = {
  ...task,
  description: "任务说明",
  created_by: { kind: "user" },
  created_at: task.updated_at,
  activity: [],
  runs: [],
};
const routine = {
  id: "r1",
  name: "测试定时",
  enabled: true,
  schedule: { kind: "daily", at: "09:00" },
  timezone: "UTC",
  model: "GPT",
  next_run_at: "2026-10-10T09:00:00Z",
  briefs: [
    { version: 1, text: "定时要求", created_at: "2026-10-09T09:00:00Z" },
  ],
  runs: [
    {
      id: "run1",
      status: "sent",
      title: "报告",
      report: "旧报告",
      started_at: "2026-10-09T09:00:00Z",
      finished_at: "2026-10-09T09:01:00Z",
      feedback: [],
    },
  ],
};
const cleanup: (() => void)[] = [];
async function render(page: "tasks" | "routines", panel = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(
    [page],
    page === "tasks" ? { tasks: [task], assignees: [] } : [routine],
  );
  client.setQueryData(["tasks", "t1"], detail);
  client.setQueryData(["chat"], { agents: [], interactions: [], messages: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {panel ? (
          <WorkspacePanel view={page} onViewChange={navigation.set} />
        ) : page === "tasks" ? (
          <TaskBoard />
        ) : (
          <RoutineBoard />
        )}
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
const refresh = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('button[aria-label="刷新"]')!;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe.each([false, true])("refresh (sidebar: %s)", (panel) => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    navigation.task =
      navigation.routine =
      navigation.run =
      navigation.edit =
        null;
    navigation.set.mockClear();
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskLayout: "list",
      taskScope: "all",
    }));
    rstest.restoreAllMocks();
  });

  it("updates tasks once, retaining the scope, layout and folded groups", async () => {
    useWorkspaceStore.getState().setWorkspace((workspace) => ({
      ...workspace,
      taskScope: "user",
      taskLayout: "list",
    }));
    let resolve!: (response: Response) => void;
    const fetch = rstest.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const container = await render("tasks", panel);
    const group = container.querySelector<HTMLButtonElement>(
      'button[aria-expanded="true"]',
    )!;
    await act(async () => group.click());
    await act(async () => {
      refresh(container).click();
      refresh(container).click();
      await settle();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refresh(container).disabled).toBe(true);
    expect(refresh(container).getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      resolve(
        new Response(
          JSON.stringify({
            tasks: [{ ...task, title: "最新任务" }],
            assignees: [],
          }),
        ),
      );
      await settle();
    });
    expect(refresh(container).disabled).toBe(false);
    expect(group.getAttribute("aria-expanded")).toBe("false");
    await act(async () => group.click());
    expect(container.textContent).toContain("最新任务");
    expect(useWorkspaceStore.getState().workspace.taskScope).toBe("user");
    expect(useWorkspaceStore.getState().workspace.taskLayout).toBe("list");
    expect(navigation.set).not.toHaveBeenCalled();
    expect((fetch.mock.calls[0][0] as Request).method).toBe("GET");
  });

  it("refreshes the shared routine query and selected report without changing navigation or feedback", async () => {
    navigation.routine = "r1";
    navigation.run = "run1";
    const fetch = rstest.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          routines: [
            {
              ...routine,
              name: "最新计划",
              runs: [{ ...routine.runs[0], report: "最新报告" }],
            },
          ],
        }),
      ),
    );
    const container = await render("routines", panel);
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="反馈"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "保留反馈草稿");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      refresh(container).click();
      await settle();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0][0] as Request).method).toBe("GET");
    expect(container.textContent).toContain("最新计划");
    expect(container.textContent).toContain("最新报告");
    expect(input.value).toBe("保留反馈草稿");
    expect(navigation.set).not.toHaveBeenCalled();
  });

  it("refreshes task details and the list while retaining the selected task", async () => {
    navigation.task = "t1";
    const fetch = rstest
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const request = input as Request;
        return new Response(
          JSON.stringify(
            request.url.endsWith("/t1")
              ? { ...detail, status: "in_review", description: "最新说明" }
              : { tasks: [{ ...task, status: "in_review" }], assignees: [] },
          ),
        );
      });
    const container = await render("tasks", panel);
    await act(async () => {
      refresh(container).click();
      await settle();
    });
    expect(fetch).toHaveBeenCalledTimes(panel ? 1 : 2);
    expect(
      fetch.mock.calls.every(
        ([request]) => (request as Request).method === "GET",
      ),
    ).toBe(true);
    expect(container.textContent).toContain("最新说明");
    if (!panel)
      expect(
        container.querySelector<HTMLSelectElement>('select[aria-label="状态"]')!
          .value,
      ).toBe("in_review");
    expect(navigation.task).toBe("t1");
    expect(navigation.set).not.toHaveBeenCalled();
  });

  it.skipIf(panel)(
    "keeps the board view when refreshed task statuses change",
    async () => {
      useWorkspaceStore.getState().setWorkspace((workspace) => ({
        ...workspace,
        taskLayout: "board",
        taskScope: "all",
      }));
      rstest.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            tasks: [{ ...task, status: "in_review" }],
            assignees: [],
          }),
        ),
      );
      const container = await render("tasks", panel);
      await act(async () => {
        refresh(container).click();
        await settle();
      });
      expect(
        container.querySelector('section[aria-label="待验收"]')?.textContent,
      ).toContain("测试任务");
      expect(useWorkspaceStore.getState().workspace.taskLayout).toBe("board");
    },
  );

  it("disables routine refresh while its query is already fetching", async () => {
    let resolve!: (response: Response) => void;
    const fetch = rstest.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const container = await render("routines", panel);
    await act(async () => {
      refresh(container).click();
      await settle();
    });
    expect(refresh(container).disabled).toBe(true);
    await act(async () => refresh(container).click());
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(new Response(JSON.stringify({ routines: [routine] })));
      await settle();
    });
    expect(refresh(container).disabled).toBe(false);
  });

  for (const page of ["tasks", "routines"] as const) {
    it(`${page}: reports refresh errors, preserves content and allows retry`, async () => {
      const fetch = rstest
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("网络断开"));
      const error = rstest.spyOn(toast, "error");
      const container = await render(page, panel);
      await act(async () => {
        refresh(container).click();
        await settle();
      });
      expect(error).toHaveBeenCalledWith("网络断开");
      expect(container.textContent).toContain(
        page === "tasks" ? "测试任务" : "测试定时",
      );
      expect(refresh(container).disabled).toBe(false);
      fetch.mockResolvedValue(
        new Response(
          JSON.stringify(
            page === "tasks"
              ? { tasks: [task], assignees: [] }
              : { routines: [routine] },
          ),
        ),
      );
      await act(async () => {
        refresh(container).click();
        await settle();
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(navigation.set).not.toHaveBeenCalled();
    });
  }
});
