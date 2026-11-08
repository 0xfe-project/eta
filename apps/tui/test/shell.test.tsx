/** The shell while connected: tab bar, tabs, layers, status area, quitting, settings problems. */
import type { TuiState } from "../src/config/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp, TEST_URL } from "./ui-support/app";
import { testConfig } from "./ui-support/config";
import { flush, KEYS, plain } from "./ui-support/render";
import { testFeature } from "./ui-support/test-extension";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

const open: { unmount: () => void }[] = [];
async function app(...args: Parameters<typeof renderApp>) {
  const rendered = await renderApp(...args);
  open.push(rendered);
  return rendered;
}
afterEach(() => {
  vi.useRealTimers();
  for (const r of open.splice(0)) r.unmount();
});

const ESC = "\u001B[";
const fg = {
  cyan: `${ESC}36m`,
  yellow: `${ESC}33m`,
  green: `${ESC}32m`,
  red: `${ESC}31m`,
  gray: `${ESC}90m`,
};
const bgBlue = `${ESC}44m`;

function lines(frame: string): string[] {
  return frame.split("\n");
}

function chats(...ids: string[]): TuiState["tabs"] {
  return ids.map((id) => ({ kind: "chat", id }));
}

async function shellWith(
  state: TuiState,
  extra: Parameters<typeof renderApp>[0] = {},
) {
  const feature = testFeature();
  const r = await app({ extensions: [feature.extension], state, ...extra });
  return { r, feature };
}

describe("tab bar", () => {
  it("numbers the open tabs from 1 and names them by their view", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a", "b"),
      activeTab: 0,
    });
    feature.titles.set("a", "Alpha");
    feature.titles.set("b", "Beta");
    await r.press(KEYS.altRight); // re-render with the titles
    const bar = lines(plain(r)).at(-1) ?? "";
    expect(bar).toContain("1:Alpha");
    expect(bar).toContain("2:Beta");
    expect(bar.indexOf("1:Alpha")).toBeLessThan(bar.indexOf("2:Beta"));
  });

  it("cuts a name longer than 20 columns and ends it with …", async () => {
    const feature = testFeature();
    feature.titles.set("a", "A very long conversation title indeed");
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: chats("a"), activeTab: 0 },
    });
    const bar = lines(plain(r)).at(-1) ?? "";
    expect(bar).not.toContain("A very long conversation title indeed");
    const shown = /1:(\S.*?…)/.exec(bar)?.[1] ?? "";
    expect(shown.startsWith("A very long")).toBe(true);
    expect([...shown].length).toBeLessThanOrEqual(20);
    expect([...shown].length).toBeGreaterThanOrEqual(19);
  });

  it("cuts by display width, so wide characters count as two columns", async () => {
    const feature = testFeature();
    feature.titles.set("a", "一二三四五六七八九十十一十二");
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: chats("a"), activeTab: 0 },
    });
    const bar = lines(plain(r)).at(-1) ?? "";
    expect(bar).toContain("一二三四五六七八九");
    expect(bar).not.toContain("十一十二");
    expect(bar).toContain("…");
  });

  it("marks running, waiting, done and failed tabs in their colours, and nothing for no status", async () => {
    const feature = testFeature();
    feature.statuses.set("a", "running");
    feature.statuses.set("b", "waiting");
    feature.statuses.set("c", "done");
    feature.statuses.set("d", "failed");
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: chats("a", "b", "c", "d", "e"), activeTab: 4 },
    });
    const frame = r.lastFrame();
    expect(frame).toContain(`${fg.cyan}●`);
    expect(frame).toContain(`${fg.yellow}!`);
    expect(frame).toContain(`${fg.green}✓`);
    expect(frame).toContain(`${fg.red}✗`);
    const bar = lines(plain(r)).at(-1) ?? "";
    expect(bar).toMatch(/1:a ●/);
    expect(bar).toMatch(/2:b !/);
    expect(bar).toMatch(/3:c ✓/);
    expect(bar).toMatch(/4:d ✗/);
    expect(bar).not.toMatch(/5:e [●!✓✗]/);
  });

  it("highlights the active tab in the selection colour", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b"), activeTab: 1 });
    const bar = lines(r.lastFrame()).at(-1) ?? "";
    const highlighted = bar.slice(bar.indexOf(bgBlue));
    expect(bar).toContain(bgBlue);
    expect(highlighted.indexOf("2:b")).toBeGreaterThanOrEqual(0);
    expect(bar.indexOf("1:a")).toBeLessThan(bar.indexOf(bgBlue));
  });

  it("uses reverse video for the active tab when selection is default", async () => {
    const config = testConfig();
    const { r } = await shellWith(
      { tabs: chats("a"), activeTab: 0 },
      {
        config: { ...config, theme: { ...config.theme, selection: "default" } },
      },
    );
    expect(lines(r.lastFrame()).at(-1)).toContain(`${ESC}7m`);
  });

  it("names a tab of an unregistered kind by its id, in the muted colour", async () => {
    const { r } = await shellWith({
      tabs: [{ kind: "gone", id: "orphan-7" }],
      activeTab: undefined,
    });
    const bar = lines(r.lastFrame()).at(-1) ?? "";
    expect(plain({ lastFrame: () => bar })).toContain("1:orphan-7");
    expect(bar).toContain(`${fg.gray}1:orphan-7`);
  });

  it("puts the pinned tabs at the right end, after the open tabs", async () => {
    const { r } = await shellWith({ tabs: chats("a"), activeTab: 0 });
    const bar = (lines(plain(r)).at(-1) ?? "").trimEnd();
    expect(bar.endsWith("Pending 3")).toBe(true);
    expect(bar.indexOf("1:a")).toBeLessThan(bar.indexOf("Pending 3"));
    // Right-aligned: the bar runs the full width.
    expect([...bar].length).toBe(100);
  });

  it("stays on one line when the tabs do not fit, cutting the line", async () => {
    const feature = testFeature();
    const ids = Array.from({ length: 12 }, (_, i) => `tab-number-${i}`);
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: chats(...ids), activeTab: 0 },
      columns: 60,
      rows: 12,
    });
    const all = lines(plain(r));
    expect(all).toHaveLength(12);
    const bar = all.at(-1) ?? "";
    expect(bar).toContain("1:tab-number-0");
    expect(bar).not.toContain("12:tab-number-11");
    expect([...bar].length).toBeLessThanOrEqual(60);
    // No other line carries a piece of the bar.
    expect(all.slice(0, -1).join("\n")).not.toMatch(/\d+:tab-number/);
  });

  it("goes to the top with layout.tabBar top, the status area staying at the bottom", async () => {
    const { r } = await shellWith(
      { tabs: chats("a"), activeTab: 0 },
      { config: testConfig({ layout: { tabBar: "top" } }) },
    );
    const all = lines(plain(r));
    expect(all[0]).toContain("1:a");
    expect(all.at(-1)).toContain(`Connected to ${TEST_URL}`);
  });

  it("draws the status area just above the tab bar at the bottom by default", async () => {
    const { r } = await shellWith({ tabs: chats("a"), activeTab: 0 });
    const all = lines(plain(r));
    expect(all.at(-1)).toContain("1:a");
    expect(all.at(-2)).toContain(`Connected to ${TEST_URL}`);
  });
});

describe("tabs", () => {
  it("restores the open tabs and the active one from the saved state", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b"), activeTab: 1 });
    expect(plain(r)).toContain("Chat view b");
    expect(plain(r)).not.toContain("Chat view a");
  });

  it("shows the home screen when no tab is active", async () => {
    const { r } = await shellWith({ tabs: chats("a"), activeTab: undefined });
    expect(plain(r)).not.toContain("Chat view");
    expect(plain(r)).toContain("/help");
  });

  it("moves to the next and previous tab, wrapping, and saves each change", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b", "c"), activeTab: 0 });
    await r.press(KEYS.altRight);
    expect(plain(r)).toContain("Chat view b");
    await r.press(KEYS.altRight);
    await r.press(KEYS.altRight);
    expect(plain(r)).toContain("Chat view a");
    await r.press(KEYS.altLeft);
    expect(plain(r)).toContain("Chat view c");
    await flush();
    expect(r.saved.map((s) => s.activeTab)).toEqual([1, 2, 0, 2]);
    expect(r.saved.at(-1)?.tabs).toEqual(chats("a", "b", "c"));
  });

  it("goes to tab N with its key, and ignores a number past the last tab", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b", "c"), activeTab: 0 });
    await r.press(KEYS.alt("3"));
    expect(plain(r)).toContain("Chat view c");
    await r.press(KEYS.alt("9"));
    expect(plain(r)).toContain("Chat view c");
    await flush();
    expect(r.saved.map((s) => s.activeTab)).toEqual([2]);
  });

  it("closes the active tab, moving to its left neighbour, and saves", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b", "c"), activeTab: 1 });
    await r.press(KEYS.ctrlW);
    await flush();
    expect(plain(r)).toContain("Chat view a");
    expect(r.saved.at(-1)).toEqual({ tabs: chats("a", "c"), activeTab: 0 });
  });

  it("closing the first tab moves to the new first one, and the last tab back home", async () => {
    const { r } = await shellWith({ tabs: chats("a", "b"), activeTab: 0 });
    await r.press(KEYS.ctrlW);
    await flush();
    expect(r.saved.at(-1)).toEqual({ tabs: chats("b"), activeTab: 0 });
    await r.press(KEYS.ctrlW);
    await flush();
    expect(r.saved.at(-1)).toEqual({ tabs: [], activeTab: undefined });
    expect(plain(r)).toContain("/help");
  });

  it("openTab brings an open tab to the front and appends a new one", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a"),
      activeTab: undefined,
    });
    await r.type("/grab");
    await r.press(KEYS.enter);
    const ctx = feature.ctx();
    ctx.openTab({ kind: "chat", id: "a" });
    await flush();
    expect(plain(r)).toContain("Chat view a");
    expect(r.saved.at(-1)).toEqual({ tabs: chats("a"), activeTab: 0 });
    ctx.openTab({ kind: "chat", id: "z" });
    await flush();
    expect(plain(r)).toContain("Chat view z");
    expect(r.saved.at(-1)).toEqual({ tabs: chats("a", "z"), activeTab: 1 });
  });

  it("closeTab closes a tab that is not in front, keeping the front one", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a", "b", "c"),
      activeTab: undefined,
    });
    await r.type("/grab");
    await r.press(KEYS.enter);
    const ctx = feature.ctx();
    ctx.openTab({ kind: "chat", id: "c" });
    await flush();
    ctx.closeTab({ kind: "chat", id: "a" });
    await flush();
    expect(plain(r)).toContain("Chat view c");
    expect(r.saved.at(-1)).toEqual({ tabs: chats("b", "c"), activeTab: 1 });
    ctx.closeTab({ kind: "chat", id: "nope" });
    await flush();
    expect(r.saved.at(-1)).toEqual({ tabs: chats("b", "c"), activeTab: 1 });
  });

  it("only the tab in front receives keys", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a", "b"),
      activeTab: 0,
    });
    await r.press("x");
    await r.press(KEYS.altRight);
    await r.press("y");
    // Ink hands every key to every active handler, so the tab in front also sees the Alt+Right
    // that switched tabs, as an empty input; only typed characters are compared here.
    expect(feature.keys.filter((k) => !k.endsWith(":"))).toEqual([
      "chat-a:x",
      "chat-b:y",
    ]);
  });

  it("drops a saved active index that points past the tabs", async () => {
    const { r } = await shellWith({ tabs: chats("a"), activeTab: 5 });
    expect(plain(r)).not.toContain("Chat view");
  });
});

describe("layers", () => {
  it("covers the main area, stacks, and only the top one receives keys", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a"),
      activeTab: undefined,
    });
    await r.type("/layer one");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain("Layer one");
    // The command input is under the layer now, so typing reaches the layer.
    await r.press("p");
    expect(feature.keys).toEqual(["layer-one:p"]);
    const commands = feature.extension.commands ?? [];
    await commands.find((c) => c.name === "layer")?.run(feature.ctx(), "two");
    await flush();
    expect(plain(r)).toContain("Layer two");
    expect(plain(r)).not.toContain("Layer one");
    await r.press("q");
    expect(feature.keys).toEqual(["layer-one:p", "layer-two:q"]);
    feature.layers.at(-1)?.close();
    await flush();
    await r.press("s");
    expect(feature.keys).toEqual(["layer-one:p", "layer-two:q", "layer-one:s"]);
  });

  it("closing the top layer gives the keys back to the one under it, then to the screen", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a"),
      activeTab: undefined,
    });
    await r.type("/grab");
    await r.press(KEYS.enter);
    const ctx = feature.ctx();
    const first = ctx.openLayer(() => "first layer");
    await flush();
    const second = ctx.openLayer(() => "second layer");
    await flush();
    expect(plain(r)).toContain("second layer");
    expect(plain(r)).not.toContain("first layer");
    second.close();
    await flush();
    expect(plain(r)).toContain("first layer");
    second.close(); // a second close does nothing
    await flush();
    expect(plain(r)).toContain("first layer");
    first.close();
    await flush();
    expect(plain(r)).toContain("/help");
    await r.type("ab");
    expect(plain(r)).toContain("ab");
  });

  it("keeps the tab view from receiving keys while a layer is open", async () => {
    const { r, feature } = await shellWith({
      tabs: chats("a"),
      activeTab: undefined,
    });
    await r.type("/grab");
    await r.press(KEYS.enter);
    const ctx = feature.ctx();
    ctx.openTab({ kind: "chat", id: "a" });
    await flush();
    const layer = ctx.openLayer(() => "over");
    await flush();
    await r.press("k");
    expect(feature.keys).toEqual([]);
    layer.close();
    await flush();
    await r.press("k");
    expect(feature.keys).toEqual(["chat-a:k"]);
  });
});

describe("status area", () => {
  it("says which address it is connected to", async () => {
    const r = await app();
    expect(plain(r)).toContain(`Connected to ${TEST_URL}`);
  });

  it("warns in yellow, all the time, that a temporary host stops with eta", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
    });
    const warning =
      "Temporary host: agents stop when you quit eta. Run /install-service to install a resident host.";
    expect(plain(r).replaceAll("\n", "")).toContain(warning.slice(0, 40));
    expect(r.lastFrame()).toContain(`${fg.yellow}Temporary host:`);
  });

  it("gives the temporary host warning in Chinese", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
      config: testConfig({ locale: "zh" }),
      columns: 200,
    });
    expect(plain(r)).toContain(
      "临时 host：退出 TUI 后 agent 会停止。用 /install-service 装常驻 host",
    );
  });

  it("warns in yellow when the host's version differs, naming both", async () => {
    const r = await app({
      patch: { versionWarning: { host: "1.2.0", tui: "1.3.0" } },
      columns: 200,
    });
    expect(plain(r)).toContain("1.2.0");
    expect(plain(r)).toContain("1.3.0");
    // The style in force where the host version is printed is yellow.
    const frame = r.lastFrame();
    const styleStart = frame.lastIndexOf(ESC, frame.indexOf("1.2.0"));
    expect(frame.slice(styleStart, styleStart + fg.yellow.length)).toBe(
      fg.yellow,
    );
  });

  it("reports a settings file that could not be written, once", async () => {
    const r = await app({ columns: 200 });
    r.controller.patch({
      saveProblem: {
        reason: "io",
        file: "/test/eta/tui.json",
        detail: "EACCES: permission denied",
      },
    });
    await flush();
    expect(plain(r)).toContain(
      "Could not write settings to /test/eta/tui.json",
    );
    expect(plain(r)).toContain("EACCES: permission denied");
  });

  it("clears an info notice after 5 seconds and a warning or error after 8", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { r } = await shellWith({ tabs: [], activeTab: undefined });
    await r.type("/say info hello there");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain("hello there");
    await vi.advanceTimersByTimeAsync(4_900);
    await flush();
    expect(plain(r)).toContain("hello there");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(plain(r)).not.toContain("hello there");

    await r.type("/say warning careful now");
    await r.press(KEYS.enter);
    await vi.advanceTimersByTimeAsync(7_900);
    await flush();
    expect(plain(r)).toContain("careful now");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(plain(r)).not.toContain("careful now");

    await r.type("/say error it broke");
    await r.press(KEYS.enter);
    await vi.advanceTimersByTimeAsync(7_900);
    await flush();
    expect(plain(r)).toContain("it broke");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(plain(r)).not.toContain("it broke");
  });

  it("replaces an old notice with a new one, and the old one's timer does not clear the new", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { r } = await shellWith({ tabs: [], activeTab: undefined });
    await r.type("/say info first notice");
    await r.press(KEYS.enter);
    await vi.advanceTimersByTimeAsync(4_000);
    await r.type("/say info second notice");
    await r.press(KEYS.enter);
    expect(plain(r)).not.toContain("first notice");
    expect(plain(r)).toContain("second notice");
    await vi.advanceTimersByTimeAsync(2_000); // the first notice's 5 s are up
    await flush();
    expect(plain(r)).toContain("second notice");
    await vi.advanceTimersByTimeAsync(3_100);
    await flush();
    expect(plain(r)).not.toContain("second notice");
  });
});

describe("quitting", () => {
  it("asks for a second press, naming the key, and quits on it", async () => {
    const r = await app();
    await r.press(KEYS.ctrlC);
    expect(plain(r)).toContain("Press ctrl+c again to quit");
    expect(r.quits()).toBe(0);
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(1);
  });

  it("forgets the first press after 2 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const r = await app();
    await r.press(KEYS.ctrlC);
    await vi.advanceTimersByTimeAsync(1_900);
    await flush();
    expect(plain(r)).toContain("Press ctrl+c again to quit");
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(plain(r)).not.toContain("Press ctrl+c again to quit");
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(0);
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(1);
  });

  it("quits from a layer too", async () => {
    const { r } = await shellWith({ tabs: [], activeTab: undefined });
    await r.type("/layer x");
    await r.press(KEYS.enter);
    await r.press(KEYS.ctrlC);
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(1);
  });

  it("works on the screens before the shell", async () => {
    const r = await app({
      phase: { name: "first-run", suggestedUrl: undefined },
    });
    await r.press(KEYS.ctrlC);
    expect(plain(r)).toContain("Press ctrl+c again to quit");
    await r.press(KEYS.ctrlC);
    expect(r.quits()).toBe(1);
  });
});

describe("settings problems at start", () => {
  const problems = [
    {
      file: "/test/eta/tui.json",
      key: "theme.accent",
      reason: "invalid-value" as const,
      detail: '"purple-ish"',
    },
    {
      file: "/test/eta/tui.json",
      key: "keybindings.tabs.next",
      reason: "wrong-type" as const,
    },
    {
      file: "/test/eta/tui.json",
      key: "colour",
      reason: "unknown-key" as const,
    },
  ];

  it("lists each problem with file, key, reason and detail, says the defaults stand in, and closes on any key", async () => {
    const r = await app({ problems, columns: 160 });
    const text = plain(r);
    expect(text).toContain("/test/eta/tui.json");
    expect(text).toContain("theme.accent");
    expect(text).toContain("not a valid value");
    expect(text).toContain('"purple-ish"');
    expect(text).toContain("keybindings.tabs.next");
    expect(text).toContain("wrong type");
    expect(text).toContain("colour");
    expect(text).toContain("unknown key");
    expect(text).toContain("default");
    await r.press("x");
    expect(plain(r)).not.toContain("theme.accent");
  });

  it("names the whole file when the key is empty", async () => {
    const r = await app({
      problems: [
        {
          file: "/test/eta/tui.json",
          key: "",
          reason: "invalid-json",
          detail: "Unexpected token",
        },
      ],
      columns: 160,
    });
    expect(plain(r)).toContain("whole file");
    expect(plain(r)).toContain("not valid JSON");
  });
});

describe("onConnected", () => {
  it("runs on every hello, first only on the first one", async () => {
    const seen: boolean[] = [];
    const r = await app({
      extensions: [
        {
          id: "probe",
          onConnected: (_ctx, first) => {
            seen.push(first);
          },
        },
      ],
    });
    await flush();
    expect(seen).toEqual([true]);
    const wire = r.controller.getState().wire!;
    wire.store.setState({ status: "reconnecting" });
    await flush();
    wire.store.setState({ status: "open" });
    await flush();
    expect(seen).toEqual([true, false]);
  });

  it("reports an extension whose onConnected fails, and keeps running", async () => {
    const r = await app({
      extensions: [
        {
          id: "bad",
          onConnected: () => {
            throw new Error("hello failed");
          },
        },
      ],
      columns: 200,
    });
    await flush();
    expect(plain(r)).toContain("hello failed");
  });
});
