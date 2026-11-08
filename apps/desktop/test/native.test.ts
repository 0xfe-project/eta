import type { NativeBridge } from "../src/bun/native";
import { BASELINE_CAPABILITIES } from "@eta/client-contracts/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startNativeBridge } from "../src/bun/native";

const REMOTE = "https://mac.ts.net";
let bridge: NativeBridge;
afterEach(() => {
  bridge.close();
});

const handlers = {
  saveFile: vi.fn(async () => "/saved"),
  openExternal: vi.fn(),
  contextMenu: vi.fn(),
  windowAction: vi.fn(),
};

const start = (origins: string[]) => {
  bridge = startNativeBridge({
    appVersion: "0.1.0",
    handlers,
    origins,
    platform: "linux",
  });
};

const ask = (
  origin: string | undefined,
  path = "/api/native/info",
  init: RequestInit = {},
) =>
  fetch(`${bridge.apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${bridge.token}`,
      ...(origin === undefined ? {} : { origin }),
    },
  });

describe("the bridge in remote mode", () => {
  it("answers the remote page's origin", async () => {
    start([REMOTE]);
    const answer = await ask(REMOTE);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("access-control-allow-origin")).toBe(REMOTE);
  });

  it.each([
    "https://evil.example",
    "https://mac.ts.net:8443",
    "http://mac.ts.net",
    "http://127.0.0.1:4000",
    "null",
  ])("refuses %s, which is not it", async (origin) => {
    start([REMOTE]);
    expect((await ask(origin)).status).toBe(403);
  });

  it("does the same for a preflight", async () => {
    start([REMOTE]);
    const answer = (origin: string) =>
      ask(origin, "/api/native/open-external", { method: "OPTIONS" });
    expect((await answer(REMOTE)).status).toBe(204);
    expect((await answer("https://evil.example")).status).toBe(403);
  });

  it("follows the window to another page, and drops the last one", async () => {
    start(["http://127.0.0.1:4000"]);
    bridge.setOrigins([REMOTE]);
    expect((await ask(REMOTE)).status).toBe(200);
    expect((await ask("http://127.0.0.1:4000")).status).toBe(403);
  });

  it("answers no page when the window shows none", async () => {
    start([]);
    expect((await ask(REMOTE)).status).toBe(403);
  });

  it("lists what it can do, the 0.1.0 bridge at least", async () => {
    start([REMOTE]);
    const info = (await (await ask(REMOTE)).json()) as {
      capabilities: string[];
    };
    expect(info.capabilities).toEqual(
      expect.arrayContaining([...BASELINE_CAPABILITIES]),
    );
  });

  it("still needs the token", async () => {
    start([REMOTE]);
    const answer = await fetch(`${bridge.apiBase}/api/native/info`, {
      headers: { origin: REMOTE },
    });
    expect(answer.status).toBe(401);
  });

  it("passes the page's request for the connection page on, with its language", async () => {
    start([REMOTE]);
    const answer = await ask(REMOTE, "/api/native/window-action", {
      method: "POST",
      body: JSON.stringify({ action: "connection", language: "zh" }),
    });
    expect(answer.status).toBe(202);
    expect(handlers.windowAction).toHaveBeenCalledWith({
      action: "connection",
      language: "zh",
    });
  });
});
