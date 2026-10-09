import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "./tasks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-09T09:00:00Z";
const run = {
  id: "run-1",
  status: "awaiting_confirmation",
  computer_id: "c1",
  computer_name: "laptop",
  runtime: "paseo",
  provider: "claude",
  workspace: null,
  nudged: false,
  error: null,
  created_at: at,
  sent_at: null,
  finished_at: null,
};
const task = {
  id: "t1",
  number: 1,
  title: "修登录页",
  status: "todo",
  assignee: { kind: "remote" },
  comments: 0,
  run_status: "awaiting_confirmation",
  updated_at: at,
  description: "",
  created_by: { kind: "agent", agent_name: "helper" },
  created_at: at,
  activity: [
    {
      id: "a1",
      kind: "run_queued",
      actor: { kind: "system" },
      body: null,
      data: { awaiting_confirmation: true },
      run_id: "run-1",
      created_at: at,
    },
  ],
  runs: [run],
} as unknown as TaskDetail;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a run an AXP agent asked for", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    rstest.restoreAllMocks();
  });

  it("waits for the user, who lets it go", async () => {
    const posts: string[] = [];
    rstest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const request = input as Request;
      posts.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ ...task, runs: [{ ...run, status: "queued" }] });
    });
    const container = document.createElement("div");
    document.body.append(container);
    await act(async () =>
      createRoot(container).render(
        <QueryClientProvider client={new QueryClient()}>
          <Timeline task={task} />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("AXP 智能体请求交给");
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "交给它",
    )!;
    await act(async () => {
      button.click();
      await settle();
    });
    expect(posts).toContain("POST /api/v1/tasks/t1/runs/run-1/confirm");
  });
});
