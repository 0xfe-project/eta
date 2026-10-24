import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { cleanup, mount } from "@/test-render";
import { WindowControls } from "./window-controls";

/** What the shell's preload injects before the page's first line runs. */
function shell(facts: Record<string, unknown> | undefined) {
  const global = globalThis as { __ETA_HOST__?: unknown };
  if (facts === undefined) delete global.__ETA_HOST__;
  else global.__ETA_HOST__ = facts;
}

afterEach(async () => {
  await cleanup();
  shell(undefined);
  rstest.restoreAllMocks();
});

describe("the window's three buttons", () => {
  it("浏览器里一个都不画：没有窗口可关，也没有 __ETA_HOST__", async () => {
    const { container } = await mount(<WindowControls />);
    expect(container.querySelector(".window-controls")).toBeNull();
  });

  it("macOS 也一个都不画：那里的三个灯是窗口自己画的", async () => {
    shell({ platform: "darwin", native: true });
    const { container } = await mount(<WindowControls />);
    expect(container.querySelector(".window-controls")).toBeNull();
  });

  it("Windows 里三个点各调各的动作，且不许拖窗口", async () => {
    const fetch = rstest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 202 }));
    shell({
      platform: "win32",
      native: true,
      nativeApiBase: "http://127.0.0.1:41234",
      nativeToken: "t0ken",
    });
    const { container } = await mount(<WindowControls />);
    const controls = container.querySelector(".window-controls");
    // 三个点是画在拖拽带上面的：整块必须 no-drag，否则按下会被窗口吃掉，点了不动。
    expect(controls?.hasAttribute("data-no-drag")).toBe(true);
    const dots = [...container.querySelectorAll("button")];
    expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual([
      "关闭窗口",
      "最小化窗口",
      "最大化或还原窗口",
    ]);

    for (const [index, action] of [
      [0, "close"],
      [1, "minimize"],
      [2, "toggle-maximize"],
    ] as const) {
      dots[index].click();
      const [url, init] = fetch.mock.calls.at(-1) ?? [];
      expect(url).toBe("http://127.0.0.1:41234/api/native/window-action");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ action });
      expect(init?.headers).toMatchObject({
        authorization: "Bearer t0ken",
      });
    }
  });
});
