import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import { i18n } from "@/lib/i18n";
import { buildProductHost } from "@/test-product";
import { cleanup, click, flush, mount } from "@/test-render";
import { HostSettings } from "./host-settings";
import { SettingsPanels } from "./settings-panels";

const realFetch = globalThis.fetch;
afterEach(async () => {
  await cleanup();
  delete window.__ETA_HOST__;
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

const shell = (extra: Record<string, unknown>) => {
  window.__ETA_HOST__ = {
    native: true,
    nativeApiBase: "http://127.0.0.1:5001",
    nativeToken: "launch-token",
    ...extra,
  };
};
const text = () => document.body.textContent ?? "";

describe("connection settings", () => {
  it("says this computer in local mode, and that nothing moves", async () => {
    shell({ connection: "local" });
    await mount(<HostSettings />);
    expect(text()).toContain("在这台电脑上运行");
    expect(text()).toContain("不会迁移");
  });

  it("says which host in remote mode", async () => {
    shell({ connection: "remote", address: "https://mac.ts.net" });
    await mount(<HostSettings />);
    expect(text()).toContain("连接到 https://mac.ts.net");
  });

  it("asks the shell for its page, and sends nothing else", async () => {
    shell({ connection: "local" });
    const fetch = rstest.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    await mount(<HostSettings />);
    await click(document.querySelector("button")!);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/native/window-action");
    expect(JSON.parse(String(init.body))).toEqual({
      action: "connection",
      language: i18n.language,
    });
  });
});

describe("the section", () => {
  const panels = async () => {
    const host = buildProductHost({}, []);
    host.install();
    host.hello();
    await mount(<SettingsPanels value="appearance" onChange={() => {}} />);
    await flush();
    return [...document.querySelectorAll("nav button")].map(
      (button) => button.textContent,
    );
  };

  it("is there in a shell that can change it", async () => {
    shell({ connection: "local" });
    expect(await panels()).toContain("连接方式");
  });

  it("is not there in a browser", async () => {
    expect(await panels()).not.toContain("连接方式");
  });

  it("is not there in a shell that cannot change it", async () => {
    shell({});
    expect(await panels()).not.toContain("连接方式");
  });
});
