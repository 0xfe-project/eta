/** One screen per connection phase: what each says and what each key does. */
import type { ConnectionPhase } from "../src/connection/types";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp, TEST_URL } from "./ui-support/app";
import { testConfig } from "./ui-support/config";
import { flush, KEYS, plain } from "./ui-support/render";
import { testFeature } from "./ui-support/test-extension";

const open: { unmount: () => void }[] = [];
async function app(...args: Parameters<typeof renderApp>) {
  const rendered = await renderApp(...args);
  open.push(rendered);
  return rendered;
}
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

const zh = testConfig({ locale: "zh" });

describe("starting screens", () => {
  it("stopped: says eta is quitting, in either language", async () => {
    const r = await app({ phase: { name: "stopped" } });
    expect(plain(r)).toContain("Quitting…");
    const zhApp = await app({ phase: { name: "stopped" }, config: zh });
    expect(plain(zhApp)).toContain("正在退出…");
  });

  it("connecting: the splash with the address it is connecting to", async () => {
    const r = await app({
      phase: {
        name: "connecting",
        url: "http://10.0.0.5:8787",
        temporary: false,
      },
    });
    expect(plain(r)).toContain("eta dev");
    expect(plain(r)).toContain("Connecting to http://10.0.0.5:8787");
  });

  it("starting-temporary: says a temporary host is starting", async () => {
    const r = await app({ phase: { name: "starting-temporary" } });
    expect(plain(r)).toContain("Starting a temporary host");
  });

  it("idle: the splash with a starting line", async () => {
    const r = await app({ phase: { name: "idle" } });
    expect(plain(r)).toContain("eta dev");
    expect(plain(r)).toContain("Starting");
  });
});

describe("first-run", () => {
  const firstRun = { name: "first-run", suggestedUrl: undefined } as const;

  it("offers the three choices, numbered", async () => {
    const r = await app({ phase: firstRun });
    const text = plain(r);
    expect(text).toContain("1");
    expect(text).toContain("Connect to a resident host");
    expect(text).toContain("Start a temporary host");
    expect(text).toContain("Install a resident host");
  });

  it("2 starts a temporary host that is saved as the connection", async () => {
    const r = await app({ phase: firstRun });
    await r.press("2");
    expect(r.controller.calls).toEqual(["startTemporary persist=true"]);
  });

  it("3 installs the resident host", async () => {
    const r = await app({ phase: firstRun });
    await r.press("3");
    expect(r.controller.calls).toEqual(["installResident"]);
  });

  it("arrows and Enter choose too", async () => {
    const r = await app({ phase: firstRun });
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.press(KEYS.down); // stays on the last choice
    await r.press(KEYS.up);
    await r.press(KEYS.enter);
    expect(r.controller.calls).toEqual(["startTemporary persist=true"]);
  });

  it("1 asks for an address, prefilled with the suggested local host, and connects when it checks out", async () => {
    const r = await app({
      phase: { name: "first-run", suggestedUrl: "http://127.0.0.1:8787" },
    });
    await r.press("1");
    expect(plain(r)).toContain("http://127.0.0.1:8787");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "checkAddress http://127.0.0.1:8787",
      "connectResident http://127.0.0.1:8787",
    ]);
  });

  it("connects to the address the host normalised it to", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = () => ({
      result: "ok",
      url: "http://box:8787",
    });
    await r.press("1");
    await r.type("box");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "checkAddress box",
      "connectResident http://box:8787",
    ]);
  });

  it("goes on to a token, shown as stars, when the host wants one", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = (url, token) =>
      token === undefined
        ? { result: "needs-token", url: "http://box:8787" }
        : { result: "ok", url: "http://box:8787" };
    await r.press("1");
    await r.type("box");
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("Token");
    await r.type("s3cret");
    expect(plain(r)).toContain("******");
    expect(plain(r)).not.toContain("s3cret");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "checkAddress box",
      "checkAddress http://box:8787 s3cret",
      "connectResident http://box:8787 s3cret",
    ]);
  });

  it("says the token was rejected and stays on the token", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = (url, token) =>
      token === undefined
        ? { result: "needs-token", url: "http://box:8787" }
        : { result: "bad-token", url: "http://box:8787" };
    await r.press("1");
    await r.type("box");
    await r.press(KEYS.enter);
    await flush();
    await r.type("wrong");
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("The host rejected this token.");
    expect(plain(r)).toContain("Token");
    expect(r.controller.calls).not.toContain(
      "connectResident http://box:8787 wrong",
    );
    r.controller.checkAddressResult = () => ({
      result: "ok",
      url: "http://box:8787",
    });
    await r.press(KEYS.backspace);
    await r.press(KEYS.backspace);
    await r.press(KEYS.backspace);
    await r.press(KEYS.backspace);
    await r.press(KEYS.backspace);
    await r.type("right");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls.at(-1)).toBe(
      "connectResident http://box:8787 right",
    );
  });

  it("says nothing answers and stays on the address", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = () => ({
      result: "unreachable",
      url: "http://box:8787",
    });
    await r.press("1");
    await r.type("box");
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("No host answers at http://box:8787.");
    expect(plain(r)).toContain("box");
    expect(plain(r)).not.toContain("Token");
    expect(r.controller.calls).toEqual(["checkAddress box"]);
  });

  it("says an invalid address is invalid", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = () => ({ result: "invalid" });
    await r.press("1");
    await r.type("::");
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("This is not a valid address.");
    expect(r.controller.calls).toEqual(["checkAddress ::"]);
  });

  it("goes back to the three choices on Esc", async () => {
    const r = await app({ phase: firstRun });
    await r.press("1");
    expect(plain(r)).not.toContain("Start a temporary host");
    await r.press(KEYS.escape);
    expect(plain(r)).toContain("Start a temporary host");
    await r.press("2");
    expect(r.controller.calls).toEqual(["startTemporary persist=true"]);
  });

  it("goes back to the three choices on Esc from the token too", async () => {
    const r = await app({ phase: firstRun });
    r.controller.checkAddressResult = () => ({
      result: "needs-token",
      url: "http://b",
    });
    await r.press("1");
    await r.type("b");
    await r.press(KEYS.enter);
    await flush();
    await r.press(KEYS.escape);
    expect(plain(r)).toContain("Start a temporary host");
  });
});

describe("host-missing", () => {
  it("gives the three ways to provide eta-host, with the Unix install path", async () => {
    const r = await app({
      phase: { name: "host-missing", wanted: "temporary" },
      platform: "linux",
    });
    const text = plain(r);
    expect(text).toContain("ETA_HOST_BIN");
    expect(text).toContain("PATH");
    expect(text).toContain("~/.eta/bin/eta-host");
  });

  it("gives the Windows install path on Windows", async () => {
    const r = await app({
      phase: { name: "host-missing", wanted: "install" },
      platform: "win32",
    });
    expect(plain(r)).toContain("%USERPROFILE%\\.eta\\bin\\eta-host.exe");
  });

  it("any key goes back", async () => {
    const r = await app({ phase: { name: "host-missing", wanted: "install" } });
    await r.press("x");
    expect(r.controller.calls).toEqual(["dismissFailure"]);
  });
});

describe("existing-host", () => {
  const url = "http://127.0.0.1:54321";
  const existing = (
    patch: Partial<Extract<ConnectionPhase, { name: "existing-host" }>> = {},
  ): ConnectionPhase => ({
    name: "existing-host",
    url,
    token: { kind: "none" },
    wanted: "temporary",
    ...patch,
  });

  it("says a host already runs here, where, and that no temporary host was started", async () => {
    const r = await app({ phase: existing() });
    const text = plain(r);
    expect(text).toContain("A host is already running on this computer");
    expect(text).toContain(url);
    expect(text).toContain("so eta did not start a temporary host");
    expect(text).toContain("1");
    expect(text).toContain("Connect to it");
    expect(text).toContain("Back");
    expect(text).not.toContain("Its token could not be read");
  });

  it("says no resident host was installed", async () => {
    const r = await app({ phase: existing({ wanted: "install" }) });
    expect(plain(r)).toContain("so eta did not install a resident host");
  });

  it("says in Chinese what it found, and which token file it could not read", async () => {
    const r = await app({
      phase: existing({
        token: { kind: "unreadable", file: "/home/me/.eta/access-token" },
      }),
      config: zh,
    });
    const text = plain(r);
    expect(text).toContain("这台电脑上已经有一个 host 在跑");
    expect(text).toContain("所以没有再起临时 host");
    expect(text).toContain("读不到令牌文件 /home/me/.eta/access-token");
    expect(text).toContain("连接它");
    expect(text).toContain("返回");
    const install = await app({
      phase: existing({ wanted: "install" }),
      config: zh,
    });
    expect(plain(install)).toContain("所以没有再装常驻 host");
  });

  it("1 connects at once with the token read from its file, and saves it as the connection", async () => {
    const r = await app({
      phase: existing({ token: { kind: "read", value: "tok-from-file" } }),
    });
    await r.press("1");
    await flush();
    expect(r.controller.calls).toEqual([
      `checkAddress ${url} tok-from-file`,
      `connectResident ${url} tok-from-file`,
    ]);
    expect(plain(r)).not.toContain("tok-from-file");
  });

  it("1 connects at once with no token when it names no token file", async () => {
    const r = await app({ phase: existing() });
    await r.press("1");
    await flush();
    expect(r.controller.calls).toEqual([
      `checkAddress ${url}`,
      `connectResident ${url}`,
    ]);
  });

  it("1 asks for the token, with the address filled in, when its token file could not be read", async () => {
    const r = await app({
      phase: existing({
        token: { kind: "unreadable", file: "/x/access-token" },
      }),
    });
    await r.press("1");
    await flush();
    expect(r.controller.calls).toEqual([]);
    expect(plain(r)).toContain("Token");
    expect(plain(r)).toContain(url);
    await r.type("pasted");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      `checkAddress ${url} pasted`,
      `connectResident ${url} pasted`,
    ]);
  });

  it("asks for the token when the token read from the file is rejected", async () => {
    const r = await app({
      phase: existing({ token: { kind: "read", value: "stale" } }),
    });
    r.controller.checkAddressResult = (_url, token) =>
      token === "fresh" ? { result: "ok", url } : { result: "bad-token", url };
    await r.press("1");
    await flush();
    expect(plain(r)).toContain("The host rejected this token.");
    expect(r.controller.calls).toEqual([`checkAddress ${url} stale`]);
    for (let i = 0; i < "stale".length; i += 1) await r.press(KEYS.backspace);
    await r.type("fresh");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls.at(-1)).toBe(`connectResident ${url} fresh`);
  });

  it("2 goes back", async () => {
    const r = await app({ phase: existing() });
    await r.press("2");
    expect(r.controller.calls).toEqual(["dismissFailure"]);
  });

  it("goes back to the two choices on Esc in the form", async () => {
    const r = await app({
      phase: existing({ token: { kind: "unreadable", file: "/x" } }),
    });
    await r.press("1");
    await r.press(KEYS.escape);
    expect(plain(r)).toContain("Connect to it");
    expect(plain(r)).not.toContain("Token");
    expect(r.controller.calls).toEqual([]);
  });
});

describe("installing", () => {
  it("says it is installing, then that it waits for the service", async () => {
    const r = await app({ phase: { name: "installing", step: "running" } });
    expect(plain(r)).toContain("Installing eta-host as a service");
    r.controller.setPhase({ name: "installing", step: "waiting-up" });
    await flush();
    expect(plain(r)).toContain("Waiting for the service to start");
  });
});

describe("install-failed", () => {
  const output = Array.from({ length: 30 }, (_, i) => `out line ${i + 1}`).join(
    "\n",
  );

  it("shows the last 20 lines of the output and the way out", async () => {
    const r = await app({
      phase: { name: "install-failed", output, step: "running" },
      rows: 40,
    });
    const text = plain(r);
    expect(text).toContain("Could not install the service");
    expect(text).toContain("out line 11");
    expect(text).toContain("out line 30");
    expect(text).not.toMatch(/out line 10\b/);
    expect(text).toContain(
      "Run eta-host yourself in another terminal or tmux, then choose “Connect to a resident host”.",
    );
  });

  it("says which part failed: running install-service, or waiting for the service", async () => {
    const running = await app({
      phase: { name: "install-failed", output: "x", step: "running" },
    });
    expect(plain(running)).toContain(
      "eta-host install-service did not succeed",
    );
    expect(plain(running)).not.toContain("never started answering");
    const waiting = await app({
      phase: { name: "install-failed", output: "x", step: "waiting-up" },
      config: zh,
    });
    expect(plain(waiting)).toContain("服务装上了，但一直没有响应");
  });

  it("any key goes back", async () => {
    const r = await app({
      phase: { name: "install-failed", output: "x", step: "running" },
    });
    await r.press(KEYS.enter);
    expect(r.controller.calls).toEqual(["dismissFailure"]);
  });
});

describe("reconnecting", () => {
  it("covers the screen with Reconnecting, the address and the seconds so far", async () => {
    const r = await app({
      phase: {
        name: "reconnecting",
        url: TEST_URL,
        temporary: false,
        since: Date.now() - 7_000,
      },
    });
    const text = plain(r);
    expect(text).toContain("Reconnecting");
    expect(text).toContain(TEST_URL);
    expect(text).toMatch(/\b7s\b/);
  });

  it("swallows other keys while it covers the shell, but two Ctrl+C still quit", async () => {
    const feature = testFeature();
    const r = await app({
      extensions: [feature.extension],
      state: {
        tabs: [
          { kind: "chat", id: "a" },
          { kind: "chat", id: "b" },
        ],
        activeTab: 0,
      },
    });
    expect(plain(r)).toContain("Chat view a");
    r.controller.setPhase({
      name: "reconnecting",
      url: TEST_URL,
      temporary: false,
      since: Date.now(),
    });
    await flush();
    expect(plain(r)).not.toContain("Chat view a");
    await r.press(KEYS.altRight);
    await r.press(KEYS.ctrlW);
    await r.press("q");
    expect(r.saved).toEqual([]);
    expect(feature.keys).toEqual([]);
    await r.press(KEYS.ctrlC);
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(1);
  });

  it("shows the shell as it was once the connection is back", async () => {
    const feature = testFeature();
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: [{ kind: "chat", id: "a" }], activeTab: 0 },
    });
    r.controller.setPhase({
      name: "reconnecting",
      url: TEST_URL,
      temporary: false,
      since: Date.now(),
    });
    await flush();
    r.controller.setPhase({
      name: "connected",
      url: TEST_URL,
      temporary: false,
    });
    await flush();
    expect(plain(r)).toContain("Chat view a");
    await r.press("k");
    expect(feature.keys).toEqual(["chat-a:k"]);
  });
});

describe("unauthorized", () => {
  it("says the token was refused and asks again, the address prefilled", async () => {
    const r = await app({
      phase: { name: "unauthorized", url: "http://box:8787" },
    });
    const text = plain(r);
    expect(text).toContain("The host at http://box:8787 rejected the token.");
    expect(text).toContain("http://box:8787");
    expect(text).toContain("Token");
  });

  it("checks the address with the new token, then connects", async () => {
    const r = await app({
      phase: { name: "unauthorized", url: "http://box:8787" },
    });
    await r.type("newtoken");
    expect(plain(r)).toContain("********");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "checkAddress http://box:8787 newtoken",
      "connectResident http://box:8787 newtoken",
    ]);
  });

  it("stays on the token when the new one is rejected too", async () => {
    const r = await app({
      phase: { name: "unauthorized", url: "http://box:8787" },
    });
    r.controller.checkAddressResult = () => ({
      result: "bad-token",
      url: "http://box:8787",
    });
    await r.type("nope");
    await r.press(KEYS.enter);
    await flush();
    expect(plain(r)).toContain("The host rejected this token.");
    expect(r.controller.calls).toEqual(["checkAddress http://box:8787 nope"]);
  });
});

describe("unreachable", () => {
  it("says it cannot connect, with the address, and offers three choices", async () => {
    const r = await app({
      phase: {
        name: "unreachable",
        url: "http://box:8787",
        reason: "timeout",
        output: undefined,
      },
    });
    const text = plain(r);
    expect(text).toContain("Cannot connect");
    expect(text).toContain("http://box:8787");
    expect(text).toContain("Use a temporary host");
    expect(text).toContain("Change the address");
    expect(text).toContain("Quit");
  });

  it("explains a temporary host that did not start, with the last 20 lines of its output", async () => {
    const output = Array.from(
      { length: 25 },
      (_, i) => `tmp line ${i + 1}`,
    ).join("\n");
    const r = await app({
      phase: {
        name: "unreachable",
        url: undefined,
        reason: "temporary-failed",
        output,
      },
      rows: 40,
    });
    const text = plain(r);
    expect(text).toContain("The temporary host did not start.");
    expect(text).toContain("tmp line 6");
    expect(text).toContain("tmp line 25");
    expect(text).not.toMatch(/tmp line 5\b/);
  });

  it("explains a temporary host that exited", async () => {
    const r = await app({
      phase: {
        name: "unreachable",
        url: "http://127.0.0.1:5555",
        reason: "temporary-exited",
        output: "bye",
      },
    });
    expect(plain(r)).toContain("The temporary host exited.");
    expect(plain(r)).toContain("bye");
  });

  it("1 starts a temporary host for this run only", async () => {
    const r = await app({
      phase: {
        name: "unreachable",
        url: "http://box:8787",
        reason: "timeout",
        output: undefined,
      },
    });
    await r.press("1");
    expect(r.controller.calls).toEqual(["startTemporary persist=false"]);
  });

  it("2 opens the address form prefilled with the current address", async () => {
    const r = await app({
      phase: {
        name: "unreachable",
        url: "http://box:8787",
        reason: "timeout",
        output: undefined,
      },
    });
    await r.press("2");
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual([
      "checkAddress http://box:8787",
      "connectResident http://box:8787",
    ]);
  });

  it("3 quits", async () => {
    const r = await app({
      phase: {
        name: "unreachable",
        url: "http://box:8787",
        reason: "timeout",
        output: undefined,
      },
    });
    await r.press("3");
    expect(r.quits()).toBe(1);
  });
});
