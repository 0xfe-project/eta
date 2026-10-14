import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CommentBox, TaskProperties } from "./tasks";

const navigation = rstest.hoisted(() => ({ open: rstest.fn() }));
rstest.mock("./use-groups", () => ({
  useGroups: () => ({
    groups: [{ id: "g1", name: "任务讨论", archived: false }],
  }),
  useOpenGroup: () => navigation.open,
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({
    agents: [
      { id: "a1", name: "Aria" },
      { id: "a2", name: "Bolt" },
      { id: "a3", name: "Cora" },
    ],
  }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const task = {
  id: "t1",
  number: 111,
  title: "验收群聊",
  status: "todo",
  assignee: { kind: "user" },
  activity: [],
  runs: [],
  assists: [],
  loops: [],
  group_id: null,
} as unknown as TaskDetail;

const cleanup: (() => void)[] = [];
async function render(group_id: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["tasks"], { tasks: [], assignees: [] });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskProperties task={{ ...task, group_id }} onDone={() => {}} />
        <CommentBox task={{ ...task, group_id }} />
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

afterEach(async () => {
  await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
  rstest.restoreAllMocks();
  navigation.open.mockClear();
});

function button(root: ParentNode, label: string) {
  return [...root.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
}

describe("任务的群讨论入口", () => {
  it("opens the linked group from its property, keeping assistance under the comment", async () => {
    const container = await render("g1");
    const row = [...container.querySelectorAll("dt")].find(
      (dt) => dt.textContent === "群",
    )!.nextElementSibling!;
    const discuss = button(row, "在群里讨论");
    expect(discuss).toBeDefined();
    expect(button(container, "新建群讨论")).toBeUndefined();
    expect(
      [...container.querySelectorAll("button")].filter(
        (b) => b.textContent === "在群里讨论",
      ),
    ).toHaveLength(1);
    await act(async () => discuss.click());
    expect(navigation.open).toHaveBeenCalledWith("g1");
    const comment = container.querySelector("#task-comment")!.closest("form")!;
    expect(comment.textContent).toContain("请 Agent 协助");
    expect(comment.textContent).not.toContain("在群里讨论");
    await act(async () => button(comment, "请 Agent 协助").click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      "还没有指派到远程电脑",
    );
  });

  it("creates a group with the selected agents, links the task, then opens it", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      const path = new URL(request.url).pathname;
      calls.push({ method: request.method, path, body: await request.json() });
      if (path === "/api/v1/groups")
        return Response.json({ id: "g2" }, { status: 201 });
      expect(navigation.open).not.toHaveBeenCalled();
      return Response.json({ ...task, group_id: "g2" });
    });
    const container = await render();
    const row = [...container.querySelectorAll("dt")].find(
      (dt) => dt.textContent === "群",
    )!.nextElementSibling!;
    await act(async () => button(row, "新建群讨论").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector("input")!.value).toBe(task.title);
    for (const name of ["Aria", "Bolt"]) {
      const label = [...dialog.querySelectorAll("label")].find((l) =>
        l.textContent?.includes(name),
      )!;
      await act(async () =>
        label.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click(),
      );
    }
    await act(async () => button(dialog, "创建群").click());
    await act(async () =>
      rstest.waitFor(() => expect(navigation.open).toHaveBeenCalledWith("g2")),
    );
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/groups",
        body: {
          name: task.title,
          goal: "讨论任务 #111：验收群聊",
          members: ["a1", "a2"],
        },
      },
      { method: "PATCH", path: "/api/v1/tasks/t1", body: { group_id: "g2" } },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
