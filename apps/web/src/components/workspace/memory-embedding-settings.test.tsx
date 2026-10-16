import { afterEach, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryEmbeddingSettings } from "./memory-embedding-settings";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const container = document.createElement("div");
document.body.append(container);
const root = createRoot(container);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await act(async () => root.render(null));
  client.clear();
  document.body
    .querySelectorAll("[role=alertdialog]")
    .forEach((e) => e.remove());
  rstest.restoreAllMocks();
});

const gemini = (available: boolean) => ({
  id: "gemini-embedding-001",
  display_name: "Gemini Embedding 001",
  status: available ? "available" : "unavailable",
  available,
  ...(available
    ? {}
    : {
        reason: {
          code: "NO_CONNECTION",
          message: "尚未绑定 Google AI Studio 账号。",
        },
      }),
});

const local = {
  space: { model: "local", dims: 768 },
  memories: 42,
  rebuild: null,
};

async function render(embedding: object, available = true) {
  client.setQueryData(["memory-embedding"], embedding);
  client.setQueryData(["llm", "embedding-models"], [gemini(available)]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryEmbeddingSettings />
      </QueryClientProvider>,
    ),
  );
}

async function open() {
  const trigger = container.querySelector<HTMLButtonElement>(
    '[role="combobox"][aria-labelledby="memory-embedding"]',
  )!;
  await act(async () =>
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}

it("switches after confirming, telling how many memories it re-embeds", async () => {
  const requests: string[] = [];
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(`${init?.method} ${String(input)} ${init?.body}`);
    return Response.json(
      {
        ...local,
        rebuild: {
          model: "gateway:gemini-embedding-001",
          dims: 768,
          status: "running",
          done: 0,
          total: 42,
          error: null,
          started_at: "2026-10-16T00:00:00Z",
          finished_at: null,
        },
      },
      { status: 202 },
    );
  });
  await render(local);
  const option = (await open()).find((el) =>
    el.textContent?.includes("Gemini Embedding 001"),
  )!;
  await act(async () => {
    option.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await pause(30);
  });
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("切换到 Gemini Embedding 001？");
  expect(dialog.textContent).toContain("全部 42 条记忆");
  expect(dialog.textContent).toContain("Google AI Studio 的配额");
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "切换",
  )!;
  await act(async () => {
    confirm.click();
    await pause(30);
  });
  expect(requests).toEqual([
    'PUT /api/bundles/memory/v1/embedding {"model":"gateway:gemini-embedding-001","dims":768}',
  ]);
  expect(container.textContent).toContain(
    "正在切换到 Gemini Embedding 001：0/42",
  );
  expect(
    container
      .querySelector('[role="progressbar"]')
      ?.getAttribute("aria-valuemax"),
  ).toBe("42");
});

it("offers Gemini only once an account is linked", async () => {
  await render(local, false);
  const option = (await open()).find((el) =>
    el.textContent?.includes("Gemini Embedding 001"),
  )!;
  expect(option.getAttribute("aria-disabled")).toBe("true");
  expect(option.textContent).toContain("尚未绑定 Google AI Studio 账号");
});

it("shows why a rebuild paused, and cancels it", async () => {
  const requests: string[] = [];
  rstest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    requests.push(`${init?.method ?? "GET"} ${String(input)}`);
    return init?.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json(local);
  });
  await render({
    ...local,
    rebuild: {
      model: "gateway:gemini-embedding-001",
      dims: 768,
      status: "paused",
      done: 10,
      total: 42,
      error: "没有可用的 Google AI Studio 账号，请先在模型服务中绑定。",
      started_at: "2026-10-16T00:00:00Z",
      finished_at: null,
    },
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "没有可用的 Google AI Studio 账号",
  );
  expect(container.textContent).toContain("10/42");
  const cancel = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "取消切换",
  )!;
  await act(async () => {
    cancel.click();
    await pause(30);
  });
  expect(requests).toEqual([
    "DELETE /api/bundles/memory/v1/embedding/rebuild",
    "GET /api/bundles/memory/v1/embedding",
  ]);
  expect(container.textContent).not.toContain("10/42");
});
