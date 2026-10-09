import type { TaskDetail } from "@/queries/tasks";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DeliveredPull } from "./task-pulls";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const url = "https://github.com/acme/web/pull/7";
const task = {
  id: "t1",
  number: 1,
  title: "任务",
  status: "in_review",
  assignee: { kind: "user" },
  comments: 0,
  run_status: null,
  updated_at: "2026-10-09T09:00:00Z",
  description: "",
  created_by: { kind: "user" },
  created_at: "2026-10-09T09:00:00Z",
  activity: [],
  runs: [],
} as unknown as TaskDetail;
const open = {
  url,
  title: "Add web",
  state: "open",
  additions: 12,
  deletions: 3,
  head_sha: "abc123",
  merge: "ready",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** fetch answering by request; calls records what was asked. */
function serve(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : null;
    const call = {
      method: request?.method ?? init?.method ?? "GET",
      url: request?.url ?? String(input),
      body: request
        ? await request.clone().text()
        : typeof init?.body === "string"
          ? JSON.parse(init.body)
          : undefined,
    };
    calls.push(call);
    return answer(call);
  });
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const cleanup: (() => void)[] = [];
async function render(status = task.status) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ul>
          <DeliveredPull
            task={{ ...task, status }}
            url={url}
            title="acme/web#7"
          />
        </ul>
      </QueryClientProvider>,
    ),
  );
  await act(settle);
  cleanup.push(() => {
    root.unmount();
    client.clear();
    container.remove();
  });
  return container;
}
const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find(
    (b) => b.textContent === name || b.getAttribute("aria-label") === name,
  );
const openMenu = async (container: HTMLElement) => {
  const trigger = button(container, "更多合并方式")!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    await settle();
  });
};
const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === name,
  ) as HTMLElement | undefined;

describe("a delivered pull request", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    rstest.restoreAllMocks();
  });

  it("shows its state and the lines it adds and removes", async () => {
    serve(() => json(open));
    const container = await render();
    expect(container.textContent).toContain("打开");
    expect(container.querySelector(".text-success")?.textContent).toBe("+12");
    expect(container.querySelector(".text-destructive")?.textContent).toBe(
      "−3",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(container.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(button(container, "合并")?.disabled).toBe(false);
  });

  it("says when GitHub cannot be read, without numbers", async () => {
    serve(() =>
      json({ error: { code: "GITHUB_UNREACHABLE", message: "连不上" } }, 424),
    );
    const container = await render();
    expect(container.textContent).toContain("状态暂不可用");
    expect(container.textContent).not.toMatch(/[+−]\d/);
    expect(button(container, "合并")).toBeUndefined();
  });

  it("cannot be merged when GitHub would refuse, and says why", async () => {
    serve(() =>
      json({ ...open, merge: "blocked", reason: "有冲突，需要先解决。" }),
    );
    const container = await render();
    expect(button(container, "合并")?.disabled).toBe(true);
    expect(button(container, "更多合并方式")?.disabled).toBe(true);
    expect(container.textContent).toContain("有冲突，需要先解决。");
  });

  it("merges at the head it shows, and leaves the task alone", async () => {
    const calls = serve((call) =>
      call.method === "POST"
        ? json({ ...open, state: "merged", merge: undefined })
        : json(open),
    );
    const container = await render();
    await act(async () => {
      button(container, "合并")!.click();
      button(container, "合并")?.click();
      await settle();
    });
    const merges = calls.filter((c) => c.method === "POST");
    expect(merges).toHaveLength(1);
    expect(merges[0].url).toBe("/api/forge/v1/pulls/merge");
    expect(merges[0].body).toEqual({ url, head_sha: "abc123" });
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("merges and completes; a failed completion is retried without merging again", async () => {
    let merged = false;
    let patches = 0;
    const calls = serve((call) => {
      if (call.method === "POST") {
        merged = true;
        return json({ ...open, state: "merged", merge: undefined });
      }
      if (call.method === "PATCH") {
        patches += 1;
        return patches === 1
          ? json({ error: { code: "INTERNAL", message: "数据库不可用" } }, 500)
          : json({ ...task, status: "done" });
      }
      return json(
        merged ? { ...open, state: "merged", merge: undefined } : open,
      );
    });
    const container = await render();
    await openMenu(container);
    await act(async () => {
      menuItem("合并并标记任务完成")!.click();
      await settle();
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(
      JSON.parse(calls.find((c) => c.method === "PATCH")!.body as string),
    ).toEqual({ status: "done" });
    expect(container.textContent).toContain("PR 已合并，任务未完成");

    await act(async () => {
      button(container, "标记任务完成")!.click();
      await settle();
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(container.textContent).not.toContain("任务未完成");
  });

  it("reads GitHub again when a merge got no answer, without retrying it", async () => {
    let reads = 0;
    const calls = serve((call) => {
      if (call.method === "POST") throw new TypeError("network");
      reads += 1;
      return json(open);
    });
    const container = await render();
    await act(async () => {
      button(container, "合并")!.click();
      await settle();
    });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(reads).toBe(2);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("offers to complete the task once merged on GitHub", async () => {
    serve(() => json({ ...open, state: "merged", merge: undefined }));
    const container = await render();
    expect(container.textContent).toContain("已合并");
    expect(button(container, "合并")).toBeUndefined();
    expect(button(container, "标记任务完成")).toBeDefined();
  });

  it("offers nothing more for a finished task", async () => {
    serve(() => json({ ...open, state: "merged", merge: undefined }));
    const container = await render("done");
    expect(button(container, "标记任务完成")).toBeUndefined();
  });
});
