/** The three commands the foundation ships: /help, /config and /install-service. */
import type { LoadedConfig } from "../src/config/types";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp, TEST_PATHS, TEST_URL } from "./ui-support/app";
import { loaded, testConfig } from "./ui-support/config";
import { flush, KEYS, plain } from "./ui-support/render";

const open: { unmount: () => void }[] = [];
async function app(...args: Parameters<typeof renderApp>) {
  const rendered = await renderApp(...args);
  open.push(rendered);
  return rendered;
}
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

async function run(r: Awaited<ReturnType<typeof app>>, line: string) {
  await r.type(line);
  await r.press(KEYS.enter);
  await flush();
}

describe("/help", () => {
  it("lists every command with its usage and summary, and closes on Esc", async () => {
    const r = await app({ columns: 140 });
    await run(r, "/help");
    const text = plain(r);
    expect(text).toContain("/config");
    expect(text).toContain("Open the settings file in your editor");
    expect(text).toContain("/help [command]");
    expect(text).toContain("/install-service");
    expect(text.indexOf("/config")).toBeLessThan(
      text.indexOf("/help [command]"),
    );
    expect(text.indexOf("/help [command]")).toBeLessThan(
      text.indexOf("/install-service"),
    );
    await r.press(KEYS.escape);
    expect(plain(r)).not.toContain("Open the settings file in your editor");
  });

  it("explains one command: usage, arguments and examples", async () => {
    const r = await app({ columns: 140 });
    await run(r, "/help help");
    const text = plain(r);
    expect(text).toContain("/help [command]");
    expect(text).toContain("The command to explain, without the slash");
    expect(text).toContain("/help config");
    expect(text).toContain("Show how to use /config");
    expect(text).not.toContain("/install-service");
  });

  it("reports a name that is no command", async () => {
    const r = await app();
    await run(r, "/help nope");
    expect(plain(r)).toContain("No command /nope");
  });

  it("accepts the name with its slash", async () => {
    const r = await app({ columns: 140 });
    await run(r, "/help /config");
    expect(plain(r)).toContain("Open the settings file in your editor");
  });

  it("lists in Chinese", async () => {
    const r = await app({ config: testConfig({ locale: "zh" }), columns: 140 });
    await run(r, "/help");
    expect(plain(r)).toContain("用编辑器打开设定文件");
  });
});

describe("/config", () => {
  function reloadTo(next: LoadedConfig) {
    return async () => next;
  }

  it("makes sure the file exists, opens it in the editor, then applies it", async () => {
    const r = await app({
      env: { EDITOR: "fake-ed --wait" },
      loadConfig: reloadTo(loaded(testConfig({ layout: { tabBar: "top" } }))),
      state: { tabs: [{ kind: "x", id: "first" }], activeTab: undefined },
    });
    await run(r, "/config");
    expect(r.ensured).toEqual([TEST_PATHS.config]);
    expect(r.launches).toEqual([
      { command: "fake-ed", args: ["--wait", TEST_PATHS.config] },
    ]);
    expect(plain(r)).toContain("Settings reloaded");
    expect(plain(r).split("\n")[0]).toContain("1:first");
  });

  it("applies a new language at once", async () => {
    const r = await app({
      loadConfig: reloadTo(loaded(testConfig({ locale: "zh" }))),
    });
    await run(r, "/config");
    expect(plain(r)).toContain("设定已重新载入");
    expect(plain(r)).toContain(`已连接 ${TEST_URL}`);
  });

  it("applies new key bindings at once", async () => {
    const config = testConfig();
    const r = await app({
      loadConfig: reloadTo(
        loaded({
          ...config,
          keybindings: {
            ...config.keybindings,
            "app.quit": [{ key: "q", ctrl: true, alt: false, shift: false }],
          },
        }),
      ),
    });
    await run(r, "/config");
    await r.press(KEYS.ctrlC);
    expect(plain(r)).not.toContain("again to quit");
    await r.press("\u0011");
    expect(plain(r)).toContain("Press ctrl+q again to quit");
  });

  it("lists the problems of the reloaded file instead of the reloaded notice", async () => {
    const r = await app({
      columns: 160,
      loadConfig: reloadTo(
        loaded(testConfig(), [
          {
            file: TEST_PATHS.config,
            key: "layout.tabBar",
            reason: "invalid-value",
            detail: '"middle"',
          },
        ]),
      ),
    });
    await run(r, "/config");
    expect(plain(r)).toContain("layout.tabBar");
    expect(plain(r)).toContain('"middle"');
    await r.press("x");
    expect(plain(r)).not.toContain("layout.tabBar");
  });

  it("says a changed connection takes effect next start, without reconnecting", async () => {
    const r = await app({
      loadConfig: reloadTo(
        loaded(
          testConfig({
            connection: { mode: "resident", url: "http://other:1" },
          }),
        ),
      ),
      columns: 160,
    });
    await run(r, "/config");
    expect(plain(r)).toContain("Connection changes take effect next start");
    expect(r.controller.calls).toEqual([]);
  });

  it("reports an editor that cannot start, and keeps running without reloading", async () => {
    let reloads = 0;
    const r = await app({
      env: { EDITOR: "no-such-editor" },
      runProcess: async () => {
        throw Object.assign(new Error("spawn no-such-editor ENOENT"), {
          code: "ENOENT",
        });
      },
      loadConfig: async () => {
        reloads += 1;
        return loaded(testConfig());
      },
      columns: 160,
    });
    await run(r, "/config");
    expect(plain(r)).toContain("no-such-editor");
    expect(plain(r)).not.toContain("Settings reloaded");
    expect(reloads).toBe(0);
    await r.type("ok");
    expect(plain(r)).toContain("ok");
  });

  it("reports a settings file it cannot create, and does not open the editor", async () => {
    const r = await app({
      ensureConfigFile: async (file) => ({
        reason: "io",
        file,
        detail: "EROFS: read-only file system",
      }),
      columns: 160,
    });
    await run(r, "/config");
    expect(plain(r)).toContain("EROFS: read-only file system");
    expect(r.launches).toEqual([]);
  });

  it("opens the editor through cmd.exe on Windows when it is a .cmd", async () => {
    const r = await app({
      platform: "win32",
      env: { VISUAL: "code --wait" },
      which: (name) => (name === "code" ? "C:\\VS Code\\bin\\code.cmd" : null),
    });
    await run(r, "/config");
    expect(r.launches[0]?.command).toBe("cmd.exe");
    expect(r.launches[0]?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  });
});

describe("/install-service", () => {
  const temporary = {
    name: "connected",
    url: TEST_URL,
    temporary: true,
  } as const;

  it("does nothing on a resident host but say so", async () => {
    const r = await app({ columns: 160 });
    await run(r, "/install-service");
    expect(plain(r)).toContain("Already connected to a resident host");
    expect(r.controller.calls).toEqual([]);
  });

  it("hands over at once when nothing would be interrupted", async () => {
    const r = await app({ phase: temporary });
    r.controller.busy = [];
    await run(r, "/install-service");
    expect(r.controller.calls).toEqual(["handoverBusy", "handover"]);
  });

  it("asks first, counting replies, tasks and routines, when something would be interrupted", async () => {
    const r = await app({ phase: temporary, columns: 160 });
    r.controller.busy = [
      { kind: "reply", name: "Chat A" },
      { kind: "reply", name: "Chat B" },
      { kind: "task", name: "Build", number: 4 },
      { kind: "routine", name: "Nightly" },
    ];
    await run(r, "/install-service");
    const text = plain(r);
    expect(text).toContain("Replies: 2");
    expect(text).toContain("Tasks: 1");
    expect(text).toContain("Routines: 1");
    expect(text).toMatch(/interrupt/);
    expect(r.controller.calls).toEqual(["handoverBusy"]);
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual(["handoverBusy", "handover"]);
  });

  it("does not hand over when the question is cancelled", async () => {
    const r = await app({ phase: temporary, columns: 160 });
    r.controller.busy = [{ kind: "task", name: "Build", number: 4 }];
    await run(r, "/install-service");
    await r.press(KEYS.escape);
    await flush();
    expect(r.controller.calls).toEqual(["handoverBusy"]);
    expect(plain(r)).not.toContain("Tasks: 1");
  });

  it("asks too when the host cannot say what is running", async () => {
    const r = await app({ phase: temporary, columns: 160 });
    r.controller.busy = undefined;
    await run(r, "/install-service");
    expect(plain(r)).toContain("may be interrupted");
    expect(r.controller.calls).toEqual(["handoverBusy"]);
    await r.press(KEYS.enter);
    await flush();
    expect(r.controller.calls).toEqual(["handoverBusy", "handover"]);
  });
});
