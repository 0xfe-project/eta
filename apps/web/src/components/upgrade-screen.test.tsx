import type { UpgradeStatusView } from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { UpgradeScreen } from "./upgrade-screen";
import { useWorkspaceStore } from "./workspace/workspace-store";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  globalThis.fetch = realFetch;
  rstest.useRealTimers();
  document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
const screen = () => document.querySelector('[role="status"]');

const upgrade = (
  fields: Partial<UpgradeStatusView> = {},
): UpgradeStatusView => ({
  id: "u1",
  state: "running",
  phase: "restarting",
  from: "1.0.0",
  to: "1.1.0",
  startedAt: 1,
  log: [],
  ...fields,
});

/** What `/upgrade/status` says, changed by assigning: a status, or `down` for no answer. */
function status(first: UpgradeStatusView | null | "down") {
  const state = { now: first };
  globalThis.fetch = (async () => {
    if (state.now === "down") throw new TypeError("connection refused");
    return Response.json(state.now);
  }) as unknown as typeof globalThis.fetch;
  return state;
}

async function open() {
  const host = buildProductHost();
  host.install();
  host.hello();
  await mount(<UpgradeScreen />);
  await flush();
}

/** Past the next poll. */
async function poll() {
  await new Promise((resolve) => setTimeout(resolve, 1600));
  await flush();
}

describe("the screen over an upgrade", () => {
  it("is not there without an upgrade, or for an old result", async () => {
    status(null);
    await open();
    expect(screen()).toBeNull();
    await cleanup();
    status(upgrade({ state: "done" }));
    await open();
    expect(screen()).toBeNull();
  });

  it("leaves the page alone while the host still serves", async () => {
    status(upgrade({ phase: "downloading" }));
    await open();
    expect(screen()).toBeNull();
  });

  it("covers it from the moment the service stops", async () => {
    status(upgrade({ phase: "stopping" }));
    await open();
    expect(text()).toContain("正在更新到 1.1.0");
    expect(text()).toContain("正在停止服务");
  });

  it("closes the settings dialog, which would hold the pointer and the focus", async () => {
    useWorkspaceStore.getState().setSettings({ open: true, section: "update" });
    status(upgrade({ phase: "stopping" }));
    await open();
    expect(useWorkspaceStore.getState().settings).toEqual({
      open: false,
      section: "update",
    });
  });

  it("keeps waiting through a host that does not answer, then reloads", async () => {
    const state = status(upgrade({ phase: "stopping" }));
    await open();
    state.now = "down";
    await poll();
    expect(text()).toContain("服务器正在重启");
    expect(text()).toContain("正在更新到 1.1.0");

    state.now = upgrade({ phase: "verifying" });
    await poll();
    expect(text()).toContain("正在检查新版本");

    const reload = rstest
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    state.now = upgrade({ state: "done" });
    await poll();
    expect(text()).toContain("已更新到 1.1.0");
    expect(text()).toContain("正在重新载入");
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
  }, 15_000);

  it("explains a roll-back, and goes when it has been read", async () => {
    const state = status(upgrade());
    await open();
    state.now = upgrade({
      state: "rolled-back",
      error: "1.1.0 did not hold (it exited).",
    });
    await poll();
    expect(text()).toContain("更新没有成功");
    expect(text()).toContain("已退回 1.0.0");
    expect(text()).toContain("it exited");
    await click(document.querySelector("button")!);
    expect(screen()).toBeNull();
  }, 15_000);

  it("stays when the host needs a person", async () => {
    const state = status(upgrade());
    await open();
    state.now = upgrade({ state: "broken", error: "going back failed too" });
    await poll();
    expect(text()).toContain("需要手动处理");
    expect(text()).toContain("journalctl");
    expect(document.querySelector("button")).toBeNull();
  }, 15_000);

  it("says nothing here of what failed before the service was touched", async () => {
    const state = status(upgrade({ phase: "downloading" }));
    await open();
    state.now = upgrade({ state: "failed", error: "checksum" });
    await poll();
    expect(screen()).toBeNull();
  }, 15_000);
});
