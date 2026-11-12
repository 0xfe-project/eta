import type { ActionName, KeyBinding, TuiConfig } from "./types";

const key = (
  name: string,
  modifiers: { ctrl?: boolean; alt?: boolean } = {},
): KeyBinding[] => [
  {
    key: name,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: false,
  },
];

const goToTab = Object.fromEntries(
  [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
    `tabs.goTo${n}`,
    key(String(n), { alt: true }),
  ]),
) as Record<`tabs.goTo${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`, KeyBinding[]>;

const keybindings: Record<ActionName, KeyBinding[]> = {
  "tabs.previous": key("left", { alt: true }),
  "tabs.next": key("right", { alt: true }),
  ...goToTab,
  "panel.open": key("left"),
  "review.open": key("r", { alt: true }),
  "tabs.close": key("w", { alt: true }),
  "reply.stop": key("escape"),
  "app.quit": key("c", { ctrl: true }),
};

/**
 * The settings with nothing written. `default` as a colour leaves the terminal's own foreground,
 * so the defaults follow the user's terminal theme, light or dark.
 */
export const DEFAULT_CONFIG: TuiConfig = {
  locale: undefined,
  connection: undefined,
  ssh: { target: undefined },
  theme: {
    brand: "default",
    brandDim: "gray",
    text: "default",
    muted: "gray",
    accent: "cyan",
    warning: "yellow",
    error: "red",
    success: "green",
    border: "gray",
    selection: "blue",
  },
  keybindings,
  layout: { tabBar: "bottom" },
  toolOutput: { previewLines: 5 },
};
