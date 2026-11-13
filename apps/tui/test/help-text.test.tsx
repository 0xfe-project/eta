/** The key section of `/help`: the fold key of a reply, and the mouse line as the settings have it. */
import type { Locale } from "../src/config/types";
import { afterEach, describe, expect, it } from "vitest";
import { renderApp } from "./ui-support/app";
import { testConfig } from "./ui-support/config";
import { flush, KEYS, plain } from "./ui-support/render";

const open: { unmount: () => void }[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.unmount();
});

async function help(options: { mouse?: boolean; locale?: Locale } = {}) {
  const r = await renderApp({
    columns: 180,
    rows: 80,
    config: testConfig({
      mouse: options.mouse ?? true,
      locale: options.locale ?? "en",
    }),
  });
  open.push(r);
  await r.type("/help");
  await r.press(KEYS.enter);
  await flush();
  return plain(r);
}

/** The screen line holding `text`, border and padding taken off. */
function lineWith(screen: string, text: string): string | undefined {
  return screen
    .split("\n")
    .find((line) => line.includes(text))
    ?.replace(/^│ ?/, "")
    .replace(/ ?│$/, "")
    .trimEnd();
}

const MOUSE_ON_EN =
  "The wheel scrolls the conversation. To select text with the mouse, hold Shift while dragging (the terminal's own selection, in most terminals)";
const MOUSE_OFF_EN =
  "To select with the mouse, use your terminal's own selection (many terminals need Shift held while dragging)";
describe("the fold key of a reply", () => {
  it("has its own line with the key the settings bind, in English", async () => {
    const screen = await help();
    const line = lineWith(screen, "Unfold or fold one reply's tool calls");
    expect(line).toMatch(/^Unfold or fold one reply's tool calls +alt\+e$/);
  });
});

describe("the mouse line", () => {
  it("with the mouse on: the wheel scrolls, Shift-drag selects", async () => {
    const screen = await help({ mouse: true });
    expect(lineWith(screen, "The wheel scrolls")).toBe(MOUSE_ON_EN);
    expect(screen).not.toContain("many terminals need Shift");
  });

  it("with the mouse off: the terminal's own selection", async () => {
    const screen = await help({ mouse: false });
    expect(lineWith(screen, "To select with the mouse")).toBe(MOUSE_OFF_EN);
    expect(screen).not.toContain("The wheel scrolls");
  });
});
