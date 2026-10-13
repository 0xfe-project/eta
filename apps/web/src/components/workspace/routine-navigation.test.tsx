import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RoutineBoard } from "./routine-board";
import { Routines } from "./routines";

const navigation = rstest.hoisted(() => ({
  routine: null as string | null,
  edit: "missing",
  run: null,
  set: rstest.fn(),
}));
rstest.mock("./routine-nav", () => ({
  useRoutineNav: () => [navigation, navigation.set],
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup: (() => void)[] = [];
let client: QueryClient;
async function render(board: boolean) {
  client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(["routines"], []);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {board ? <RoutineBoard /> : <Routines />}
      </QueryClientProvider>,
    ),
  );
  const currentClient = client;
  cleanup.push(() => {
    root.unmount();
    currentClient.clear();
    container.remove();
  });
  return container;
}

async function settle() {
  const deadline = Date.now() + 5000;
  while (client.isFetching() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const missing = () =>
  new Response(
    JSON.stringify({ error: { code: "NOT_FOUND", message: "资源不存在。" } }),
    { status: 404 },
  );

describe.each([false, true])(
  "routine editing navigation (full page: %s)",
  (board) => {
    afterEach(async () => {
      await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
      navigation.routine = null;
      navigation.edit = "missing";
      navigation.set.mockClear();
      rstest.restoreAllMocks();
    });

    it("shows loading for an edit target instead of falling back to the empty list", async () => {
      let resolve!: (response: Response) => void;
      const fetch = rstest.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      const container = await render(board);
      expect(container.querySelector('[role="status"]')?.textContent).toContain(
        "正在加载",
      );
      if (!board) expect(container.textContent).not.toContain("还没有定时任务");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect((fetch.mock.calls[0][0] as Request).url).toContain(
        "/routines/missing",
      );
      await act(async () => {
        resolve(missing());
        await settle();
      });
      expect(container.textContent).toContain("这个定时任务已不存在");
      expect(container.querySelector('[role="status"]')).toBeNull();
    });

    it("shows a failed edit request with a working retry", async () => {
      const fetch = rstest
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: "INTERNAL", message: "测试服务错误" },
            }),
            { status: 500 },
          ),
        )
        .mockResolvedValueOnce(missing());
      const container = await render(board);
      await act(async () => {
        await settle();
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "测试服务错误",
      );
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "重试",
      )!;
      await act(async () => {
        retry.click();
        await settle();
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("这个定时任务已不存在");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it("uses the same missing state for a selected routine", async () => {
      navigation.edit = "";
      navigation.routine = "missing";
      rstest.spyOn(globalThis, "fetch").mockResolvedValue(missing());
      const container = await render(board);
      await act(async () => {
        await settle();
      });
      expect(container.textContent).toContain("这个定时任务已不存在");
    });
  },
);

describe("routine panel back navigation", () => {
  afterEach(async () => {
    await act(async () => cleanup.splice(0).forEach((dispose) => dispose()));
    navigation.routine = null;
    navigation.edit = "missing";
    navigation.set.mockClear();
    rstest.restoreAllMocks();
  });

  it("clears the stale edit target when returning to the list", async () => {
    rstest.spyOn(globalThis, "fetch").mockResolvedValue(missing());
    const container = await render(false);
    await act(async () => {
      await settle();
    });
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "定时任务",
    )!;
    await act(async () => back.click());
    expect(navigation.set).toHaveBeenCalledWith({
      edit: null,
      routine: null,
      run: null,
    });
  });
});
