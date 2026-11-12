/** The home screen: the splash, its narrow fallback, and the command input under it. */
import type { SlashCommand } from "../src/extensions/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOGO_LINES } from "../src/ui/logo";
import { renderApp, TEST_URL } from "./ui-support/app";
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

/** The line right above the input, where the last completion is listed. */
function lineAboveInput(text: string): string {
  const all = text.split("\n");
  return all[all.findIndex((line) => line.startsWith("› ")) - 1] ?? "";
}

/** The line the input is on: the one with the prompt. */
function inputLine(text: string): string {
  return text.split("\n").find((line) => line.startsWith("› ")) ?? "";
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
    expect(text).toContain("List the commands, or show how to use one");
  });

  it("says when the host is a temporary one", async () => {
    const r = await app({
      phase: { name: "connected", url: TEST_URL, temporary: true },
    });
    // The status area warns about a temporary host anyway; this is the splash's own line.
    expect(plain(r)).toContain(`Host ${TEST_URL} (temporary)`);
  });

  it("hints at /new with its own summary only when a /new command is registered", async () => {
    const without = await app();
    expect(plain(without)).not.toContain("/new");
    const withNew = await app({
      extensions: [
        { id: "chat", commands: [command("new", "Start a conversation")] },
      ],
    });
    expect(plain(withNew)).toContain("/new");
    expect(plain(withNew)).toContain("Start a conversation");
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

  it("lists matching commands with their summaries above the input while a name is typed", async () => {
    const r = await app();
    await r.type("/he");
    const text = plain(r);
    expect(text).toContain("/help");
    expect(text).toContain("List the commands, or show how to use one");
    expect(text).not.toContain("/config");
    expect(lineAboveInput(text)).toContain("/help");
    expect(lineAboveInput(text)).toContain(
      "List the commands, or show how to use one",
    );
  });

  it("lists at most 8 commands", async () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      command(`x${String(i).padStart(2, "0")}`),
    );
    const r = await app({ extensions: [{ id: "many", commands: many }] });
    await r.type("/x");
    const text = plain(r);
    expect(text).toContain("/x07");
    expect(text).not.toContain("/x08");
  });

  it("stops listing once a space follows the name", async () => {
    const r = await app();
    await r.type("/help ");
    expect(lineAboveInput(plain(r))).not.toContain("/help");
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
