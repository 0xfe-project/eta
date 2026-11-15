import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import {
  hasCapability,
  host,
  markHost,
  openConnectionPage,
  openExternal,
  watchExternalLinks,
} from "./native";

/** A page as the shell's preload leaves it. */
function shell(extra: Record<string, unknown> = {}) {
  window.__ETA_HOST__ = {
    native: true,
    nativeApiBase: "http://127.0.0.1:5001",
    nativeToken: "launch-token",
    platform: "darwin",
    appVersion: "0.1.0",
    role: "dev",
    ...extra,
  };
}

function serve(answer: unknown, init?: ResponseInit) {
  const fetch = rstest.fn(
    async (_url: string, _init?: RequestInit): Promise<Response> =>
      answer instanceof Response
        ? answer
        : new Response(JSON.stringify(answer), {
            status: 200,
            headers: { "content-type": "application/json" },
            ...init,
          }),
  );
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

afterEach(() => {
  delete window.__ETA_HOST__;
  delete document.documentElement.dataset.host;
  document.body.innerHTML = "";
  globalThis.fetch = rstest.fn() as unknown as typeof globalThis.fetch;
});

describe("capabilities", () => {
  it("are none in a browser", () => {
    expect(hasCapability("open-external")).toBe(false);
  });

  it("are what the shell lists", () => {
    shell({ capabilities: ["open-external"] });
    expect(hasCapability("open-external")).toBe(true);
    expect(hasCapability("save-file")).toBe(false);
  });

  it("are the 0.1.0 bridge's when the shell lists none", () => {
    shell();
    expect(hasCapability("connection")).toBe(true);
  });
});

describe("in a browser", () => {
  it("has no host, and does not write the attribute", () => {
    expect(host()).toMatchObject({ kind: "browser", connection: undefined });
    expect(markHost().kind).toBe("browser");
    expect(document.documentElement.hasAttribute("data-host")).toBe(false);
  });

  it("asks the window for nothing", async () => {
    const fetch = serve({});
    await openExternal("https://example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves links to the tab", async () => {
    const fetch = serve({});
    watchExternalLinks();
    const link = document.createElement("a");
    link.href = "https://example.com/docs";
    link.target = "_blank";
    document.body.append(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("in the shell", () => {
  it("says so on <html>, with what the shell said about itself", () => {
    shell({ error: undefined });
    expect(markHost()).toEqual({
      kind: "desktop",
      platform: "darwin",
      appVersion: "0.1.0",
      role: "dev",
      error: undefined,
      connection: undefined,
      address: undefined,
    });
    expect(document.documentElement.dataset.host).toBe("desktop");
  });

  it("knows whether its host is this computer's or a remote one", () => {
    shell({ connection: "local" });
    expect(host()).toMatchObject({
      connection: "local",
      address: undefined,
    });
    shell({ connection: "remote", address: "https://mac.ts.net" });
    expect(host()).toMatchObject({
      connection: "remote",
      address: "https://mac.ts.net",
    });
  });

  it("does not take an older shell's silence for an answer", () => {
    shell();
    expect(host().connection).toBeUndefined();
    shell({ connection: "somewhere" });
    expect(host().connection).toBeUndefined();
  });

  it("asks the window for the connection page in the page's language", async () => {
    shell({ connection: "remote" });
    const fetch = serve({});
    await openConnectionPage("en");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5001/api/native/window-action");
    expect(init!.body).toBe(
      JSON.stringify({ action: "connection", language: "en" }),
    );
  });

  it("gives no bridge when the shell forgot its token", async () => {
    shell({ nativeToken: undefined });
    const fetch = serve({});
    await openExternal("https://example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks with this launch's token, uncached and without a cookie", async () => {
    shell();
    const fetch = serve({});
    await openExternal("https://example.com");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5001/api/native/open-external");
    expect(init!.body).toBe(JSON.stringify({ url: "https://example.com" }));
    expect(init!.cache).toBe("no-store");
    expect(init!.credentials).toBe("omit");
    expect((init!.headers as Record<string, string>).authorization).toBe(
      "Bearer launch-token",
    );
  });

  it("takes a refused or unreachable window in its stride", async () => {
    shell();
    serve(new Response("authentication_failed", { status: 401 }));
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    await expect(openExternal("https://example.com")).resolves.toBeUndefined();
  });

  it("hands links to the system browser instead of leaving", async () => {
    shell();
    const fetch = serve(new Response(null, { status: 202 }));
    const stop = watchExternalLinks();
    const link = document.createElement("a");
    link.href = "https://github.com/eta/eta";
    link.target = "_blank";
    document.body.append(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5001/api/native/open-external");
    expect(JSON.parse(String(init!.body))).toEqual({
      url: "https://github.com/eta/eta",
    });
    stop();
  });

  it("keeps same-page links in the page", async () => {
    shell();
    const fetch = serve(new Response(null, { status: 202 }));
    const stop = watchExternalLinks();
    const link = document.createElement("a");
    link.href = "/settings";
    document.body.append(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    stop();
  });
});
