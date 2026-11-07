import { afterEach, describe, expect, it, vi } from "vitest";
import { startNativeBridge } from "../src/bun/native";
import { pagePreload, relayedRequest, relayToBridge } from "../src/bun/preload";

const facts = {
  native: true,
  nativeApiBase: "http://127.0.0.1:9000",
  nativeToken: "bridge-token",
};

interface PageWindow {
  top?: unknown;
  fetch: unknown;
  __electrobunSendToHost: (message: unknown) => void;
  __ETA_HOST__?: unknown;
  __ETA_SHELL__?: unknown;
  __etaBridgeAnswer?: (id: number, status: number, body: string) => void;
}

/** Run a preload in a window of our own making. */
function run(
  source: string,
  place: { origin: string; protocol?: string; top?: boolean },
) {
  const sent: unknown[] = [];
  const fetchSpy = vi.fn(async () => new Response("direct"));
  const window: PageWindow = {
    fetch: fetchSpy,
    __electrobunSendToHost: (message: unknown) => sent.push(message),
  };
  window.top = place.top === false ? {} : window;
  // eslint-disable-next-line no-new-func -- a preload is source; running it is the test.
  new Function("window", "location", "Response", source)(
    window,
    {
      origin: place.origin,
      protocol: place.protocol ?? new URL(place.origin).protocol,
    },
    Response,
  );
  return { fetchSpy, sent, window };
}

describe("what a page is told", () => {
  const source = pagePreload({ facts, origin: "https://mac.ts.net" });

  it("reaches the page it was written for", () => {
    const { window } = run(source, { origin: "https://mac.ts.net" });
    expect(window.__ETA_HOST__).toEqual(facts);
  });

  it("does not reach a site the window wandered to", () => {
    const { window } = run(source, { origin: "https://evil.example" });
    expect(window.__ETA_HOST__).toBeUndefined();
  });

  it("does not reach a frame inside the page", () => {
    const { window } = run(source, {
      origin: "https://mac.ts.net",
      top: false,
    });
    expect(window.__ETA_HOST__).toBeUndefined();
  });

  it("gives the connection token to the shell's page and no other", () => {
    const origin = "http://127.0.0.1:5000";
    const shell = pagePreload({ facts, origin, shellToken: "shell-token" });
    expect(run(shell, { origin }).window.__ETA_SHELL__).toEqual({
      token: "shell-token",
    });
    expect(
      run(pagePreload({ facts, origin }), { origin }).window,
    ).not.toHaveProperty("__ETA_SHELL__");
  });

  it("still tells a page with no origin to check, on top", () => {
    const placeholder = pagePreload({ facts, origin: undefined });
    expect(
      run(placeholder, { origin: "views://mainview", protocol: "views:" })
        .window.__ETA_HOST__,
    ).toEqual(facts);
  });
});

describe("an https page's bridge calls", () => {
  const source = pagePreload({ facts, origin: "https://mac.ts.net" });
  const secure = () => run(source, { origin: "https://mac.ts.net" });
  const pageFetch = (window: PageWindow) =>
    window.fetch as (url: string, init?: RequestInit) => Promise<Response>;

  it("go through the shell, with the token", () => {
    const { sent, window } = secure();
    void pageFetch(window)(`${facts.nativeApiBase}/api/native/info`);
    expect(sent).toEqual([
      {
        etaBridge: 1,
        path: "/api/native/info",
        method: "GET",
        token: "bridge-token",
      },
    ]);
  });

  it("resolve with what the bridge said", async () => {
    const { window } = secure();
    const answer = pageFetch(window)(`${facts.nativeApiBase}/api/native/info`);
    window.__etaBridgeAnswer?.(1, 200, "{}");
    await expect((await answer).json()).resolves.toEqual({});
  });

  it("leave every other request alone", async () => {
    const { fetchSpy, sent, window } = secure();
    await pageFetch(window)("/upgrade/status");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });

  it("are not touched on an http page, whose fetch reaches the bridge by itself", () => {
    const origin = "http://10.0.0.2:8790";
    const { sent, window } = run(pagePreload({ facts, origin }), { origin });
    void pageFetch(window)(`${facts.nativeApiBase}/api/native/info`);
    expect(sent).toEqual([]);
  });
});

describe("relaying a call", () => {
  const bridges: { close: () => void }[] = [];
  afterEach(() => {
    for (const bridge of bridges.splice(0)) bridge.close();
  });

  it.each([
    [undefined],
    ["text"],
    [{ etaBridge: 1 }],
    [{ etaBridge: 1, path: "/up", method: "GET", token: "t" }],
    [{ etaBridge: 1, path: "/api/native/info", method: "PUT", token: "t" }],
    [{ etaBridge: "1", path: "/api/native/info", method: "GET", token: "t" }],
  ])("ignores %j, which is not a bridge call", (message) => {
    expect(relayedRequest(message)).toBeUndefined();
  });

  const bridge = () => {
    const started = startNativeBridge({
      appVersion: "0.1.0",
      origins: [],
      platform: "linux",
      handlers: {
        saveFile: async () => null,
        openExternal: () => {},
        contextMenu: () => {},
        windowAction: () => {},
      },
    });
    bridges.push(started);
    return started;
  };

  it("makes the same request and hands the answer back", async () => {
    const { apiBase, token } = bridge();
    const request = relayedRequest({
      etaBridge: 7,
      path: "/api/native/info",
      method: "GET",
      token,
    });
    const answer = await relayToBridge(apiBase, request!);
    expect(answer).toMatch(/^window\.__etaBridgeAnswer\?\.\(7, 200, /);
    expect(answer).toContain("isDesktop");
  });

  it("does not get a page past the bridge's token", async () => {
    const { apiBase } = bridge();
    const request = relayedRequest({
      etaBridge: 7,
      path: "/api/native/info",
      method: "GET",
      token: "guessed",
    });
    expect(await relayToBridge(apiBase, request!)).toContain("(7, 401, ");
  });
});
