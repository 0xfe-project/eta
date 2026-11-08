/** Settings for the interface tests, with every key bound and named colours that are easy to find in a frame. */
import type {
  ActionName,
  KeyBinding,
  LoadedConfig,
  TuiConfig,
} from "../../src/config/types";

function bind(
  key: string,
  mods: Partial<Omit<KeyBinding, "key">> = {},
): KeyBinding[] {
  return [{ key, ctrl: false, alt: false, shift: false, ...mods }];
}

const TEST_KEYBINDINGS: Record<ActionName, KeyBinding[]> = {
  "tabs.previous": bind("left", { alt: true }),
  "tabs.next": bind("right", { alt: true }),
  "tabs.goTo1": bind("1", { alt: true }),
  "tabs.goTo2": bind("2", { alt: true }),
  "tabs.goTo3": bind("3", { alt: true }),
  "tabs.goTo4": bind("4", { alt: true }),
  "tabs.goTo5": bind("5", { alt: true }),
  "tabs.goTo6": bind("6", { alt: true }),
  "tabs.goTo7": bind("7", { alt: true }),
  "tabs.goTo8": bind("8", { alt: true }),
  "tabs.goTo9": bind("9", { alt: true }),
  "panel.open": bind("left"),
  "review.open": bind("r", { ctrl: true }),
  "tabs.close": bind("w", { ctrl: true }),
  "reply.stop": bind("escape"),
  "app.quit": bind("c", { ctrl: true }),
  "transcript.pageUp": bind("pageup"),
  "transcript.pageDown": bind("pagedown"),
  "transcript.lineUp": bind("up", { shift: true }),
  "transcript.lineDown": bind("down", { shift: true }),
  "transcript.top": bind("home", { ctrl: true }),
  "transcript.bottom": bind("end", { ctrl: true }),
  "transcript.search": bind("f", { ctrl: true }),
  "transcript.select": bind("v", { alt: true }),
  "transcript.expandAll": bind("o", { ctrl: true }),
  "message.newline": [
    ...bind("enter", { alt: true }),
    ...bind("enter", { shift: true }),
  ],
  "message.steer": bind("tab"),
};

export function testConfig(overrides: Partial<TuiConfig> = {}): TuiConfig {
  return {
    locale: "en",
    connection: { mode: "resident", url: "http://127.0.0.1:9999" },
    ssh: { target: undefined },
    theme: {
      brand: "#ffffff",
      brandDim: "#808080",
      text: "default",
      muted: "gray",
      accent: "cyan",
      warning: "yellow",
      error: "red",
      success: "green",
      border: "gray",
      selection: "blue",
    },
    keybindings: TEST_KEYBINDINGS,
    layout: { tabBar: "bottom" },
    toolOutput: { previewLines: 10 },
    ...overrides,
  };
}

export function loaded(
  config: TuiConfig,
  problems: LoadedConfig["problems"] = [],
): LoadedConfig {
  return { path: "/test/eta/tui.json", exists: true, config, problems };
}
