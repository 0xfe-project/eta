import type {
  UpgradeCheckView,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { setWire } from "@/lib/wire";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { UpdateSettings } from "./update-settings";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  setWire(undefined);
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

const task = { kind: "task", number: 45, name: "x" } as const;
const text = () => document.body.textContent ?? "";
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (item) => item.textContent === name,
  );

const checked: UpgradeCheckView = {
  version: "1.0.0",
  latest: "1.1.0",
  available: true,
  blocked: null,
  busy: [],
  error: null,
};

/** A host with this check, and a status at `/upgrade/status`. */
async function open(
  check: Partial<UpgradeCheckView> = {},
  status: UpgradeStatusView | null = null,
) {
  globalThis.fetch = (async () =>
    Response.json(status)) as unknown as typeof globalThis.fetch;
  const start = rstest.fn((_args: unknown) => ({ id: "u1" }));
  const cancel = rstest.fn((_args: unknown) => ({ cancelled: true }));
  const host = buildProductHost({}, ["upgrade"])
    .handle("upgrade.check", () => ({ ...checked, ...check }))
    .handle("upgrade.start", start)
    .handle("upgrade.cancel", cancel);
  host.install();
  host.hello();
  await mount(<UpdateSettings />);
  await flush();
  return { start, cancel };
}

const running = (
  phase: UpgradeStatusView["phase"],
  busy?: UpgradeStatusView["busy"],
): UpgradeStatusView => ({
  id: "u1",
  state: "running",
  phase,
  from: "1.0.0",
  to: "1.1.0",
  startedAt: 1,
  log: [],
  ...(busy === undefined ? {} : { busy }),
});

describe("Settings → 更新", () => {
  it("shows the versions and starts after asking", async () => {
    const { start } = await open();
    expect(text()).toContain("1.0.0");
    expect(text()).toContain("1.1.0");
    await click(button("更新到 1.1.0")!);
    expect(start).not.toHaveBeenCalled();
    await click(button("更新")!);
    expect(start).toHaveBeenCalledWith({ force: false });
  });

  it("names the agents a restart would stop, and offers to wait", async () => {
    const { start } = await open({ busy: [task, task] });
    await click(button("更新到 1.1.0")!);
    expect(text()).toContain("任务 #45 x");
    expect(document.querySelectorAll("li")).toHaveLength(1);
    await click(button("等它们结束再更新")!);
    expect(start).toHaveBeenCalledWith({ force: false });
  });

  it("restarts over them only when told to", async () => {
    const { start } = await open({ busy: [task] });
    await click(button("更新到 1.1.0")!);
    await click(button("现在更新")!);
    expect(start).toHaveBeenCalledWith({ force: true });
  });

  it("has no button when it is up to date", async () => {
    await open({ available: false, latest: "1.0.0" });
    expect(text()).toContain("已是最新");
    expect(button("更新到 1.0.0")).toBeUndefined();
  });

  it.each([
    ["source", "从源码运行"],
    ["no-service", "不是作为服务运行"],
    ["other-file", "另一个文件"],
  ] as const)("says why it cannot: %s", async (blocked, words) => {
    await open({ blocked });
    expect(text()).toContain(words);
    expect(button("更新到 1.1.0")).toBeUndefined();
  });

  it("says when the release could not be found", async () => {
    await open({ latest: null, available: false, error: "no network" });
    expect(text()).toContain("no network");
    expect(text()).not.toContain("已是最新");
  });

  it("shows what a running upgrade waits for, and can stop it", async () => {
    const { cancel } = await open(
      {},
      running("waiting", [task, { kind: "reply", name: "eta" }]),
    );
    expect(text()).toContain("等智能体结束");
    expect(text()).toContain("任务 #45 x");
    expect(text()).toContain("eta 里的回复");
    expect(button("更新到 1.1.0")).toBeUndefined();
    await click(button("取消更新")!);
    expect(cancel).toHaveBeenCalled();
  });

  it("cannot stop one past the point of no return", async () => {
    await open({}, running("backing-up"));
    expect(button("取消更新")).toBeUndefined();
  });

  it("says why the last one failed, and lets it be tried again", async () => {
    await open(
      {},
      { ...running("downloading"), state: "failed", error: "checksum" },
    );
    expect(text()).toContain("checksum");
    expect(button("更新到 1.1.0")).toBeDefined();
  });
});
