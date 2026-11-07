import type {
  UpgradeArgs,
  UpgradeCheckView,
  UpgradeStatusView,
} from "@eta/client-contracts";
import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { act } from "react";
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
const button = (name: string, nth = 0) =>
  [...document.querySelectorAll("button")].filter(
    (item) => item.textContent === name,
  )[nth];

const checked: UpgradeCheckView = {
  version: "1.0.0",
  latest: "1.1.0",
  available: true,
  blocked: null,
  busy: [],
  upstream: {
    label: "0xfe-project/eta",
    source: "build",
    saved: null,
    fallback: "0xfe-project/eta",
  },
  token: { host: "github.com", from: "gh", saved: null },
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
  const setUpstream = rstest.fn((args: unknown) => {
    if ((args as UpgradeArgs["setUpstream"]).upstream === "nonsense")
      throw new Error("not a repository");
    return checked.upstream;
  });
  const setToken = rstest.fn((_args: unknown) => ({ saved: "github.com" }));
  const host = buildProductHost({}, ["upgrade"])
    .handle("upgrade.check", () => ({ ...checked, ...check }))
    .handle("upgrade.start", start)
    .handle("upgrade.cancel", cancel)
    .handle("upgrade.setUpstream", setUpstream)
    .handle("upgrade.setToken", setToken);
  host.install();
  host.hello();
  await mount(<UpdateSettings />);
  await flush();
  return { start, cancel, setUpstream, setToken };
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
    ["no-windows-service", "管理员终端"],
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

  describe("where updates come from", () => {
    const fork = {
      label: "someone/fork",
      source: "setting",
      saved: "someone/fork",
      fallback: "0xfe-project/eta",
    } as const;
    const type = async (value: string) => {
      const input = document.querySelector("input")!;
      await act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("warns whose code this is, and saves what is typed", async () => {
      const { setUpstream } = await open();
      expect(text()).toContain("0xfe-project/eta");
      expect(text()).toContain("默认");
      await click(button("修改")!);
      expect(text()).toContain("这决定这台服务器运行谁的代码");
      expect(button("保存")?.disabled).toBe(true);
      expect(text()).not.toContain("恢复默认");
      await type(" someone/fork ");
      await click(button("保存")!);
      await flush();
      expect(setUpstream).toHaveBeenCalledWith({ upstream: "someone/fork" });
      expect(text()).not.toContain("这决定这台服务器运行谁的代码");
    });

    it("goes back to the default", async () => {
      const { setUpstream } = await open({ upstream: fork });
      await click(button("修改")!);
      expect(document.querySelector("input")?.value).toBe("someone/fork");
      await click(button("恢复默认（0xfe-project/eta）")!);
      await flush();
      expect(setUpstream).toHaveBeenCalledWith({});
    });

    it("stays open on what the host refuses", async () => {
      const { setUpstream } = await open();
      await click(button("修改")!);
      await type("nonsense");
      await click(button("保存")!);
      await flush();
      expect(setUpstream).toHaveBeenCalled();
      expect(text()).toContain("这决定这台服务器运行谁的代码");
    });

    it("offers no change the environment would overrule", async () => {
      await open({
        upstream: { ...fork, label: "other/one", source: "env" },
      });
      expect(text()).toContain("other/one");
      expect(text()).toContain("ETA_RELEASES_URL");
      expect(button("修改")).toBeUndefined();
    });

    it("leaves it alone while an upgrade runs", async () => {
      await open({}, running("waiting"));
      expect(button("修改")?.disabled).toBe(true);
    });
  });

  describe("the access token", () => {
    const type = async (value: string) => {
      const input = document.querySelector("input")!;
      await act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("says where it comes from, and saves one", async () => {
      const { setToken } = await open();
      expect(text()).toContain("gh 的登录");
      await click(button("设置")!);
      expect(text()).toContain("只会发给 github.com");
      expect(document.querySelector("input")?.type).toBe("password");
      expect(button("删除")).toBeUndefined();
      await type("ghp_x");
      await click(button("保存")!);
      await flush();
      expect(setToken).toHaveBeenCalledWith({ token: "ghp_x" });
    });

    it("starts empty and can be removed once saved", async () => {
      const { setToken } = await open({
        token: { host: "github.com", from: "Settings", saved: "github.com" },
      });
      expect(text()).toContain("在这里保存");
      await click(button("修改", 1)!);
      expect(document.querySelector("input")?.value).toBe("");
      await click(button("删除")!);
      await flush();
      expect(setToken).toHaveBeenCalledWith({});
    });

    it("says when the environment comes first", async () => {
      await open({
        token: { host: "github.com", from: "GH_TOKEN", saved: "github.com" },
      });
      expect(text()).toContain("服务器的 GH_TOKEN");
      expect(text()).toContain("GH_TOKEN 优先");
    });

    it("says when a saved one is for another host", async () => {
      await open({
        token: { host: "ghe.corp", from: "gh", saved: "github.com" },
      });
      expect(text()).toContain("属于 github.com");
    });

    it("has no row for a server that takes its own", async () => {
      await open({ token: { host: null, from: null, saved: "github.com" } });
      expect(text()).not.toContain("访问令牌");
    });
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
