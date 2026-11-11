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
  delete window.__ETA_HOST__;
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

  it("says nothing about where the host is in a browser or on this computer", async () => {
    window.__ETA_HOST__ = { native: true, connection: "local" };
    await open();
    expect(text()).not.toContain("连接的 host");
    await click(button("更新到 1.1.0")!);
    expect(text()).toContain("服务器会重启");
  });

  it("names the remote host it would update, which is not this computer", async () => {
    window.__ETA_HOST__ = {
      native: true,
      connection: "remote",
      address: "https://mac.ts.net",
    };
    const { start } = await open();
    expect(text()).toContain("连接的 host");
    expect(text()).toContain("https://mac.ts.net");
    await click(button("更新到 1.1.0")!);
    expect(text()).toContain("这台电脑上的东西不变");
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

describe("in a desktop app that updates itself", () => {
  /** The app's bridge, answering its update as a sequence of presses moves it on. */
  async function openDesktop(connection: "local" | "remote", busy = [task]) {
    let state: Record<string, unknown> = { state: "idle", current: "0.2.0" };
    const asked: string[] = [];
    window.__ETA_HOST__ = {
      native: true,
      nativeApiBase: "http://127.0.0.1:5001",
      nativeToken: "t",
      connection,
      capabilities: [
        "open-external",
        "save-file",
        "context-menu",
        "window-action",
        "connection",
        "shell-update",
      ],
    };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith("/api/native/shell-update"))
        return Response.json(null);
      if (init?.method === "POST") {
        const { action } = JSON.parse(String(init.body)) as { action: string };
        asked.push(action);
        state =
          action === "check"
            ? { state: "available", version: "0.3.0", current: "0.2.0" }
            : action === "download"
              ? { state: "ready", version: "0.3.0", current: "0.2.0" }
              : { state: "applying", version: "0.3.0", current: "0.2.0" };
      }
      return Response.json(state);
    }) as unknown as typeof globalThis.fetch;
    const product = buildProductHost({}, ["upgrade"]).handle(
      "upgrade.check",
      () => ({ ...checked, busy }),
    );
    product.install();
    product.hello();
    await mount(<UpdateSettings />);
    await flush();
    return { asked };
  }

  it("keeps its own version apart from the host's, and does nothing unasked", async () => {
    const { asked } = await openDesktop("local");
    expect(text()).toContain("桌面端");
    expect(text()).toContain("0.2.0");
    expect(text()).toContain("1.0.0");
    expect(asked).toEqual([]);
  });

  it("checks, downloads and restarts as the user presses, saying what the host's restart stops", async () => {
    const { asked } = await openDesktop("local");
    await click(button("检查更新")!);
    await flush();
    await click(button("下载 0.3.0")!);
    await flush();
    await click(button("重启并更新到 0.3.0")!);
    await flush();
    expect(text()).toContain("这台电脑上的 host 也会跟着重启");
    expect(text()).toContain("任务 #45 x");
    await act(async () => button("现在重启")!.click());
    await flush();
    expect(asked).toEqual(["check", "download", "apply"]);
  });

  it("says the remote host is not touched", async () => {
    await openDesktop("remote");
    await click(button("检查更新")!);
    await flush();
    await click(button("下载 0.3.0")!);
    await flush();
    await click(button("重启并更新到 0.3.0")!);
    await flush();
    expect(text()).toContain("连接的 host 不受影响");
    expect(text()).not.toContain("任务 #45 x");
  });
});
