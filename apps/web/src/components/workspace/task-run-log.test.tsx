import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "./tasks";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const at = "2026-10-13T14:37:09Z";
const hash = "a3e5d677c333b634bfd2bf46ca12f4e7de60708876871800da6a2d43b9cd96d6";
const task = {
  id: "t1",
  number: 111,
  title: "设计",
  status: "in_progress",
  assignee: { kind: "user" },
  comments: 0,
  run_status: "completed",
  updated_at: at,
  description: "",
  created_by: { kind: "user" },
  created_at: at,
  activity: [
    {
      id: "a1",
      kind: "run_started",
      actor: { kind: "system" },
      run_id: "r1",
      body: null,
      data: {},
      created_at: at,
    },
  ],
  runs: [
    {
      id: "r1",
      status: "completed",
      computer_id: "c1",
      computer_name: "remote-builder",
      runtime: "paseo",
      provider: "claude",
      workspace: null,
      nudged: false,
      error: null,
      created_at: at,
      sent_at: at,
      finished_at: at,
    },
  ],
} as unknown as TaskDetail;

const cleanup: (() => void)[] = [];

describe("a run's log", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    rstest.restoreAllMocks();
  });

  it("says where the agent read an image, in order, without a broken one", async () => {
    rstest.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            entries: [
              { kind: "assistant", text: "截图看看", at },
              { kind: "image", text: `${hash}.png`, at },
              { kind: "image", text: `${hash}.jpg`, at },
              { kind: "assistant", text: "布局对了", at },
            ],
            older: "",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => {
      root.unmount();
      client.clear();
      container.remove();
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Timeline task={task} />
        </QueryClientProvider>,
      ),
    );
    const open = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("执行记录"),
    )!;
    await act(async () => open.click());
    await act(async () =>
      rstest.waitFor(() => expect(client.isFetching()).toBe(0)),
    );
    // React Query's own settling runs on a macrotask here; one tick before reading the DOM.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const log = container.querySelector('ol[aria-label="执行记录"]')!;
    const items = [...log.children].map((li) => li.textContent);
    // In order, and no broken <img>.
    expect(items).toEqual([
      "回复截图看看",
      "读取了图片",
      "读取了图片",
      "回复布局对了",
    ]);
    expect(log.querySelector("img")).toBeNull();
  });
});
