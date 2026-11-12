/** The home screen: the splash, its narrow fallback, and the command input under it. */
import type { Extension, SlashCommand } from "../src/extensions/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatKeyBinding } from "../src/config/keys";
import { extensions as realExtensions } from "../src/extensions.gen";
import { LOGO_LINES } from "../src/ui/logo";
import { renderApp, TEST_URL } from "./ui-support/app";
import { testConfig } from "./ui-support/config";
import { flush, KEYS, plain } from "./ui-support/render";
import { hasBackground } from "./ui-support/sgr";
import { testFeature } from "./ui-support/test-extension";

// Ink's colour library reads this once, when it loads, so it is set before any import.
vi.hoisted(() => {
  globalThis.process.env.FORCE_COLOR = "3";
});

// The real extensions as a list this file owns, so one test can take a feature out of it.
vi.mock("../src/extensions.gen", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/extensions.gen")>();
  return { extensions: [...real.extensions] };
});

/** Runs `body` with the real extension `id` left out of the registry, putting it back after. */
async function withoutExtension<T>(id: string, body: () => Promise<T>) {
  const at = realExtensions.findIndex((extension) => extension.id === id);
  const [removed] = at === -1 ? [] : realExtensions.splice(at, 1);
  try {
    return await body();
  } finally {
    if (removed !== undefined) realExtensions.splice(at, 0, removed);
  }
}

const open: { unmount: () => void }[] = [];
async function app(...args: Parameters<typeof renderApp>) {
  const rendered = await renderApp(...args);
  open.push(rendered);
  return rendered;
}
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

function command(name: string, summary = `About ${name}`): SlashCommand {
  return {
    name,
    args: [],
    summary: { en: summary, zh: `关于 ${name}` },
    examples: [],
    requiredOps: [],
    run: () => {},
  };
}

/** A line of nothing but `─`, `columns` wide. */
function isRule(line: string, columns = 100): boolean {
  return columns > 0 && line === "─".repeat(columns);
}

/** The index of the input line: the first line with the prompt right under a rule of any width. */
function inputIndex(lines: readonly string[]): number {
  return lines.findIndex((line, i) => {
    const above = lines[i - 1] ?? "";
    return line.startsWith("› ") && isRule(above, [...above].length);
  });
}

/** The line right under the input's lower rule, where the first completion is listed. */
function lineBelowInput(text: string): string {
  const all = text.split("\n");
  return all[inputIndex(all) + 2] ?? "";
}

/** The `count` lines under the input's lower rule, ends trimmed: where the completion menu is. */
function menuRows(text: string, count: number): string[] {
  const all = text.split("\n");
  const first = inputIndex(all) + 2;
  return all.slice(first, first + count).map((line) => line.trimEnd());
}

/** The line the input is on. */
function inputLine(text: string): string {
  const all = text.split("\n");
  return all[inputIndex(all)] ?? "";
}

describe("splash on the home screen", () => {
  it("shows the logo, the name and version, the host and the /help hint", async () => {
    const r = await app({ tuiVersion: "1.4.0" });
    const text = plain(r);
    for (const line of LOGO_LINES.filter((l) => l.trim() !== ""))
      expect(text).toContain(line.trimEnd());
    expect(text).toContain("eta 1.4.0");
    expect(text).toContain(TEST_URL);
    expect(text).toContain("/help");
    expect(text).toContain("Commands and keys");
  });

  it("says when the host is a temporary one", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
    });
    // The status area warns about a temporary host anyway; this is the splash's own line.
    expect(plain(r)).toContain(`Host ${TEST_URL} (temporary)`);
  });

  it("hints at /new only when a /new command is registered", async () => {
    // The real /new belongs to the manage feature: without it, nothing registers /new.
    const without = await withoutExtension("manage", () => app());
    expect(plain(without)).not.toContain("/new");
    expect(plain(without)).not.toContain("New conversation");
    expect(plain(without)).toContain("/help");
    // A second /new beside the manage feature's would not register, so it stands in for it.
    const withNew = await withoutExtension("manage", () =>
      app({
        extensions: [
          { id: "chat", commands: [command("new", "Start a conversation")] },
        ],
      }),
    );
    expect(plain(withNew)).toContain("/new");
    expect(plain(withNew)).toContain("New conversation");
  });

  it("falls back to one line on a narrow terminal", async () => {
    const r = await app({ columns: 30, tuiVersion: "1.4.0" });
    const text = plain(r);
    expect(text).toContain(`eta 1.4.0 · ${TEST_URL}`.slice(0, 29));
    expect(text).not.toContain("█");
  });

  it("falls back to one line on a short terminal", async () => {
    const r = await app({ rows: 9 });
    expect(plain(r)).toContain(`eta dev · ${TEST_URL}`);
    expect(plain(r)).not.toContain("█");
    expect(plain(r).split("\n")).toHaveLength(9);
  });

  it("switches between the logo and the line as the terminal is resized", async () => {
    const r = await app();
    expect(plain(r)).toContain("█");
    r.stdout.resize(30, 30);
    await flush();
    expect(plain(r)).not.toContain("█");
    r.stdout.resize(100, 30);
    await flush();
    expect(plain(r)).toContain("█");
  });

  it("does not show once a tab is open", async () => {
    const feature = testFeature();
    const r = await app({
      extensions: [feature.extension],
      state: { tabs: [{ kind: "chat", id: "a" }], activeTab: 0 },
    });
    expect(plain(r)).not.toContain("█");
    expect(plain(r)).not.toContain("eta dev");
  });
});

describe("command input", () => {
  it("takes typed text, Chinese included, and deletes with Backspace", async () => {
    const r = await app();
    await r.type("ab中文");
    expect(inputLine(plain(r))).toContain("ab中文");
    await r.press(KEYS.backspace);
    expect(inputLine(plain(r))).toContain("ab中");
    expect(inputLine(plain(r))).not.toContain("ab中文");
  });

  it("clears on Esc", async () => {
    const r = await app();
    await r.type("hello");
    await r.press(KEYS.escape);
    expect(inputLine(plain(r))).not.toContain("hello");
  });

  it("takes a paste, turning line breaks into spaces", async () => {
    const r = await app();
    await r.press(KEYS.paste("one\ntwo\r\nthree"));
    expect(inputLine(plain(r))).toContain("one two three");
  });

  it("lists matching commands with their summaries under the input while a name is typed", async () => {
    const r = await app();
    await r.type("/he");
    const text = plain(r);
    expect(text).toContain("/help");
    expect(text).toContain("List the commands, or show how to use one");
    expect(text).not.toContain("/config");
    expect(lineBelowInput(text)).toContain("/help");
    expect(lineBelowInput(text)).toContain(
      "List the commands, or show how to use one",
    );
  });

  it("lists every match, eight rows at a time, with a line for how many more are below", async () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      command(`x${String(i).padStart(2, "0")}`),
    );
    const r = await app({ extensions: [{ id: "many", commands: many }] });
    await r.type("/x");
    const menu = menuRows(plain(r), 8);
    expect(menu[0]).toMatch(/^› \/x00 {2}About x00/);
    expect(menu[6]).toMatch(/^ {2}\/x06 {2}About x06/);
    expect(menu[7]).toBe("↓ 4 more");
    await r.press(KEYS.up);
    expect(menuRows(plain(r), 8).at(-1)).toMatch(/^› \/x10 {2}About x10/);
  });

  it("stops listing once a space follows the name", async () => {
    const r = await app();
    await r.type("/help ");
    expect(plain(r)).not.toContain("List the commands, or show how to use one");
  });

  it("completes the first match and a space with Tab", async () => {
    const r = await app();
    await r.type("/con");
    await r.press(KEYS.tab);
    expect(inputLine(plain(r))).toContain("/config ");
    await r.type("x");
    expect(inputLine(plain(r))).toContain("/config x");
  });

  it("reports an unknown command and keeps going", async () => {
    const r = await app();
    await r.type("/nope");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain("Unknown command /nope");
    await r.type("ok");
    expect(inputLine(plain(r))).toContain("ok");
  });

  it("clears the input after Enter", async () => {
    const r = await app();
    await r.type("/nope");
    await r.press(KEYS.enter);
    expect(inputLine(plain(r))).not.toContain("/nope");
  });

  it("says there is no conversation yet when the text is not a command", async () => {
    const r = await app();
    await r.type("hello");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain(
      "No conversation is open. Type / to see commands.",
    );
  });

  it("refuses a command the host lacks an op for, without running it", async () => {
    const feature = testFeature();
    const r = await app({
      extensions: [feature.extension],
      ops: ["other.op"],
      columns: 160,
    });
    await r.type("/needy");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain("This host is too old for /needy");
    expect(plain(r)).toContain("thing.do");
    expect(feature.ran).toEqual([]);
  });

  it("runs the command when the host has the op", async () => {
    const feature = testFeature();
    const r = await app({ extensions: [feature.extension], ops: ["thing.do"] });
    await r.type("/needy");
    await r.press(KEYS.enter);
    expect(feature.ran).toEqual(["needy"]);
  });

  it("shows the error of a command that throws, and keeps running", async () => {
    const feature = testFeature();
    const r = await app({ extensions: [feature.extension] });
    await r.type("/boom");
    await r.press(KEYS.enter);
    expect(plain(r)).toContain("the command broke");
    await r.type("still");
    expect(inputLine(plain(r))).toContain("still");
  });
});

const ZZ_COMMANDS: Extension = {
  id: "zz",
  commands: ["zza", "zzb", "zzc"].map((name) => command(name)),
};

describe("home layout", () => {
  it("starts with the logo on the first line, then a blank line, the input between two rules and the hints", async () => {
    const r = await app({ tuiVersion: "1.4.0" });
    const all = plain(r).split("\n");
    LOGO_LINES.forEach((line, i) => {
      expect(all[i]?.startsWith(line.trimEnd())).toBe(true);
    });
    const after = LOGO_LINES.length;
    expect(all[after]?.trim()).toBe("");
    expect(isRule(all[after + 1] ?? "")).toBe(true);
    expect(all[after + 2]?.startsWith("› ")).toBe(true);
    expect(isRule(all[after + 3] ?? "")).toBe(true);
    expect(all[after + 4]).toMatch(/^\/new +New conversation/);
    expect(all[after + 5]).toMatch(/^\/help +Commands and keys/);
    expect(all[after + 6]).toMatch(/^← +Open pending/);
    // Free space stays under the hints, down to the status line and the tab bar.
    for (const line of all.slice(after + 7, -2)) expect(line.trim()).toBe("");
  });

  it("names the first key bound to panel.open, and leaves the hint out when none is", async () => {
    const config = testConfig();
    const first = { key: "p", ctrl: true, alt: false, shift: false };
    const rebound = [
      first,
      { key: "left", ctrl: false, alt: false, shift: false },
    ];
    const r = await app({
      config: {
        ...config,
        keybindings: { ...config.keybindings, "panel.open": rebound },
      },
    });
    const shown = formatKeyBinding(first);
    expect(plain(r)).toContain(shown);
    expect(plain(r)).toMatch(
      new RegExp(`${shown.replace("+", "\\+")} +Open pending`),
    );
    expect(plain(r)).not.toMatch(/← +Open pending/);
    const unbound = await app({
      config: {
        ...config,
        keybindings: { ...config.keybindings, "panel.open": [] },
      },
    });
    expect(plain(unbound)).not.toContain("Open pending");
    expect(plain(unbound)).toContain("Commands and keys");
  });

  it("makes the rules as wide as the terminal, following a resize", async () => {
    const r = await app({ columns: 80 });
    expect(
      plain(r)
        .split("\n")
        .filter((l) => isRule(l, 80)),
    ).toHaveLength(2);
    r.stdout.resize(90, 30);
    await flush();
    expect(
      plain(r)
        .split("\n")
        .filter((l) => isRule(l, 90)),
    ).toHaveLength(2);
  });

  it("puts the one-line splash first on a narrow terminal, the input right under it", async () => {
    const r = await app({ columns: 30, tuiVersion: "1.4.0" });
    const all = plain(r).split("\n");
    expect(all[0]).toContain("eta 1.4.0");
    expect(isRule(all[1] ?? "", 30)).toBe(true);
    expect(all[2]?.startsWith("› ")).toBe(true);
    expect(isRule(all[3] ?? "", 30)).toBe(true);
    expect(all[4]).toContain("/new");
    expect(plain(r)).not.toContain("█");
  });

  it("drops the hints before the logo on a short terminal", async () => {
    // 8 logo rows, a blank one and 3 for the input: 12, plus the status line and the tab bar.
    const r = await app({ rows: 14 });
    const text = plain(r);
    expect(text).toContain("█");
    expect(inputLine(text).startsWith("› ")).toBe(true);
    expect(text).not.toContain("New conversation");
    expect(text).not.toContain("Commands and keys");
  });

  it("falls back to the one-line splash one row shorter, with the hints when they fit", async () => {
    const r = await app({ rows: 13 });
    const all = plain(r).split("\n");
    expect(plain(r)).not.toContain("█");
    expect(all[0]).toContain(`eta dev · ${TEST_URL}`);
    expect(isRule(all[1] ?? "")).toBe(true);
    expect(all[4]).toContain("New conversation");
  });

  it("keeps the input when even the one-line splash and the hints do not fit", async () => {
    // Four rows for the main area: the splash line and the input.
    const r = await app({ rows: 6 });
    const all = plain(r).split("\n");
    expect(all).toHaveLength(6);
    expect(all[0]).toContain("eta dev");
    expect(isRule(all[1] ?? "")).toBe(true);
    expect(all[2]?.startsWith("› ")).toBe(true);
    expect(isRule(all[3] ?? "")).toBe(true);
    expect(plain(r)).not.toContain("New conversation");
    // Three rows: no room for the splash line, and the input stays whole.
    const tiny = await app({ rows: 5 });
    const rows = plain(tiny).split("\n");
    expect(isRule(rows[0] ?? "")).toBe(true);
    expect(rows[1]?.startsWith("› ")).toBe(true);
    expect(isRule(rows[2] ?? "")).toBe(true);
  });

  it("lists completions under the lower rule in place of the hints, keeping the logo on top", async () => {
    const r = await app();
    await r.type("/he");
    const all = plain(r).split("\n");
    expect(all[0]?.startsWith(LOGO_LINES[0]?.trimEnd() ?? "?")).toBe(true);
    const input = inputIndex(all);
    expect(all[input]).toContain("/he");
    expect(isRule(all[input + 1] ?? "")).toBe(true);
    expect(all[input + 2]).toContain("/help");
    expect(plain(r)).not.toContain("New conversation");
    expect(plain(r)).not.toContain("Open pending");
  });
});

describe("home completion menu", () => {
  it("draws no background or reverse video in any row", async () => {
    const r = await app({ extensions: [ZZ_COMMANDS] });
    await r.type("/zz");
    await r.press(KEYS.down);
    const all = plain(r).split("\n");
    const raw = r.lastFrame().split("\n");
    const first = inputIndex(all) + 2;
    for (const row of [first, first + 1, first + 2]) {
      expect(all[row]).toContain("/zz");
      expect(hasBackground(raw[row] ?? "")).toBe(false);
    }
  });

  it("moves the selection with down and up, wrapping, and completes the selected one with Tab", async () => {
    const r = await app({ extensions: [ZZ_COMMANDS] });
    await r.type("/zz");
    await r.press(KEYS.down);
    let all = plain(r).split("\n");
    expect(all[inputIndex(all) + 3]).toMatch(/^› \/zzb/);
    expect(all[inputIndex(all) + 2]).toMatch(/^ {2}\/zza/);
    await r.press(KEYS.tab);
    expect(inputLine(plain(r))).toContain("/zzb ");
    await r.press(KEYS.escape);
    await r.type("/zz");
    await r.press(KEYS.up);
    all = plain(r).split("\n");
    expect(all[inputIndex(all) + 4]).toMatch(/^› \/zzc/);
    await r.press(KEYS.down);
    all = plain(r).split("\n");
    expect(all[inputIndex(all) + 2]).toMatch(/^› \/zza/);
    await r.press(KEYS.up);
    await r.press(KEYS.tab);
    expect(inputLine(plain(r))).toContain("/zzc ");
  });

  it("goes back to the first row when the typed text changes", async () => {
    const r = await app({ extensions: [ZZ_COMMANDS] });
    await r.type("/z");
    await r.press(KEYS.down);
    await r.press(KEYS.down);
    await r.type("z");
    const all = plain(r).split("\n");
    expect(all[inputIndex(all) + 2]).toMatch(/^› \/zza/);
    await r.press(KEYS.tab);
    expect(inputLine(plain(r))).toContain("/zza ");
  });
});

/** The real commands in the order a lone `/` lists them. */
function realCommandNames(): string[] {
  return realExtensions
    .flatMap((extension) => extension.commands ?? [])
    .map((c) => c.name)
    .sort();
}

/** Presses `key` `times` times. */
async function pressTimes(
  r: { press: (data: string) => Promise<void> },
  key: string,
  times: number,
) {
  for (let i = 0; i < times; i++) await r.press(key);
}

describe("home completion menu with every real command", () => {
  it("lists them all after a lone /, eight rows at a time", async () => {
    const names = realCommandNames();
    expect(names.length).toBeGreaterThan(8);
    const r = await app();
    await r.type("/");
    const menu = menuRows(plain(r), 8);
    expect(menu[0]?.startsWith(`› /${names[0]} `)).toBe(true);
    for (let i = 1; i < 7; i++)
      expect(menu[i]?.startsWith(`  /${names[i]} `)).toBe(true);
    expect(menu[7]).toBe(`↓ ${names.length - 7} more`);
  });

  it("goes down to the last command, which shows and is selected; the last row is not held by /help", async () => {
    const names = realCommandNames();
    const last = names.at(-1) ?? "?";
    expect(last).not.toBe("help");
    const r = await app();
    await r.type("/");
    await pressTimes(r, KEYS.down, names.length - 1);
    const menu = menuRows(plain(r), 8);
    expect(menu[0]).toBe(`↑ ${names.length - 7} more`);
    expect(menu[7]?.startsWith(`› /${last} `)).toBe(true);
    expect(menu.join("\n")).not.toContain("/help");
    expect(plain(r)).not.toContain("↓");
  });

  it("completes with Tab a command the window scrolled to", async () => {
    const names = realCommandNames();
    const r = await app();
    await r.type("/");
    await pressTimes(r, KEYS.down, 13);
    expect(menuRows(plain(r), 8).join("\n")).toContain(`› /${names[13]} `);
    await r.press(KEYS.tab);
    expect(inputLine(plain(r))).toContain(`/${names[13]} `);
  });

  it("goes back to the first match and the top when the typed text changes", async () => {
    const r = await app();
    await r.type("/");
    await pressTimes(r, KEYS.down, 12);
    await r.type("a");
    const menu = menuRows(plain(r), 8);
    expect(menu[0]).toMatch(/^› \/agent /);
    expect(plain(r)).not.toContain("↑");
  });

  it("lines the summaries up in one column that stays put while the window scrolls", async () => {
    const names = realCommandNames();
    const r = await app();
    await r.type("/");
    const summaryColumn = (line: string) =>
      /^[› ] \/\S+ +/.exec(line)?.[0].length;
    const top = menuRows(plain(r), 7).map(summaryColumn);
    await pressTimes(r, KEYS.down, names.length - 1);
    const bottom = menuRows(plain(r), 8).slice(1).map(summaryColumn);
    const widest = Math.max(...names.map((name) => name.length));
    // The marker, the slash, the widest name and two spaces.
    expect(new Set([...top, ...bottom])).toEqual(new Set([3 + widest + 2]));
  });

  it("shrinks to the rows left on a short terminal, the selection in view", async () => {
    const names = realCommandNames();
    // Eight rows for the main area: the input takes three, the menu the other five.
    const r = await app({ rows: 10 });
    await r.type("/");
    let all = plain(r).split("\n");
    expect(all).toHaveLength(10);
    expect(isRule(all[0] ?? "")).toBe(true);
    expect(all[1]?.startsWith("› /")).toBe(true);
    expect(isRule(all[2] ?? "")).toBe(true);
    expect(all[3]?.startsWith(`› /${names[0]} `)).toBe(true);
    expect(all[7]).toBe(`↓ ${names.length - 4} more`);
    await pressTimes(r, KEYS.down, names.length - 1);
    all = plain(r).split("\n");
    expect(all).toHaveLength(10);
    expect(all[3]).toBe(`↑ ${names.length - 4} more`);
    expect(all[7]?.startsWith(`› /${names.at(-1)} `)).toBe(true);
  });

  it("keeps one row for the menu when the terminal has no more", async () => {
    const names = realCommandNames();
    // Four rows for the main area: the input and one row of the menu.
    const r = await app({ rows: 6 });
    await r.type("/");
    let all = plain(r).split("\n");
    expect(all).toHaveLength(6);
    expect(all[1]?.startsWith("› /")).toBe(true);
    expect(all[3]?.startsWith(`› /${names[0]} `)).toBe(true);
    await pressTimes(r, KEYS.down, 5);
    all = plain(r).split("\n");
    expect(all[3]?.startsWith(`› /${names[5]} `)).toBe(true);
  });

  it("writes the summaries and how many more in Chinese", async () => {
    const names = realCommandNames();
    const first = realExtensions
      .flatMap((extension) => extension.commands ?? [])
      .find((c) => c.name === names[0]);
    const r = await app({ config: testConfig({ locale: "zh" }) });
    await r.type("/");
    const menu = menuRows(plain(r), 8);
    expect(menu[0]).toContain(first?.summary.zh ?? "?");
    expect(menu[7]).toBe(`↓ 还有 ${names.length - 7} 项`);
  });

  it("does not open without a /", async () => {
    const r = await app();
    await r.type("agent");
    expect(plain(r)).not.toContain("more");
    expect(plain(r)).toContain("Commands and keys");
  });
});
