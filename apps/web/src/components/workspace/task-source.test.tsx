import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskProperties } from "./tasks";

rstest.mock("./use-groups", () => ({
  useGroups: () => ({
    groups: [{ id: "g1", name: "任务讨论", archived: false }],
  }),
  useOpenGroup: () => () => {},
}));
rstest.mock("./use-agents", () => ({
  useAgents: () => ({ agents: [] }),
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
async function render(group_id: string | null) {
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
});

describe("任务详情的来源", () => {
  it.each([["g1"], [null]])(
    "shows neither the source group nor a way to it (%s)",
    async (group_id) => {
      const container = await render(group_id);
      const labels = [...container.querySelectorAll("dt")].map(
        (dt) => dt.textContent,
      );
      expect(labels).toEqual(["状态", "指派给"]);
      expect(container.querySelector('[aria-label="关联群"]')).toBeNull();
      expect(container.textContent).not.toContain("任务讨论");
    },
  );
});
