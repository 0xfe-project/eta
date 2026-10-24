import { afterEach, describe, expect, it, rstest } from "@rstest/core";
import {
  host,
  markHost,
  openExternal,
  pickFolder,
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

describe("in a browser", () => {
  it("has no host, and does not write the attribute", () => {
    expect(host()).toMatchObject({ kind: "browser" });
    expect(markHost().kind).toBe("browser");
    expect(document.documentElement.hasAttribute("data-host")).toBe(false);
  });

  it("asks the window for nothing, and a typed path stays the path", async () => {
    const fetch = serve({ path: "/elsewhere" });
    expect(await pickFolder("/srv")).toBeNull();
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
    });
    expect(document.documentElement.dataset.host).toBe("desktop");
  });

  it("gives no bridge when the shell forgot its token", async () => {
    shell({ nativeToken: undefined });
    const fetch = serve({ path: "/srv/eta" });
    expect(await pickFolder()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("picks a folder from where the field already points", async () => {
    shell();
    const fetch = serve({ path: "/Users/me/code/eta" });
    expect(await pickFolder("/Users/me/code")).toBe("/Users/me/code/eta");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:5001/api/native/folder-dialog");
    expect(init!.body).toBe(
      JSON.stringify({ startingFolder: "/Users/me/code" }),
    );
    expect(init!.cache).toBe("no-store");
    expect(init!.credentials).toBe("omit");
    expect((init!.headers as Record<string, string>).authorization).toBe(
      "Bearer launch-token",
    );
  });

  it("treats a cancelled dialog as no answer", async () => {
    shell();
    serve({ path: null });
    expect(await pickFolder("/srv")).toBeNull();
  });

  it("treats a refused or unreachable window as no answer", async () => {
    shell();
    serve(new Response("authentication_failed", { status: 401 }));
    expect(await pickFolder("/srv")).toBeNull();
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await pickFolder("/srv")).toBeNull();
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
