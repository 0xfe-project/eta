import type { ActionName, KeyBinding, TuiConfig } from "./types";

const key = (
  name: string,
  modifiers: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyBinding[] => [
  {
    key: name,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
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
  "transcript.pageUp": key("pageup"),
  "transcript.pageDown": key("pagedown"),
  "transcript.lineUp": key("up", { shift: true }),
  "transcript.lineDown": key("down", { shift: true }),
  "transcript.top": key("home", { ctrl: true }),
  "transcript.bottom": key("end", { ctrl: true }),
  "transcript.search": key("f", { ctrl: true }),
  "transcript.select": key("v", { alt: true }),
  "transcript.expandAll": key("o", { ctrl: true }),
  // Shift+Enter only reaches a program in terminals that report it; Alt+Enter works everywhere.
  "message.newline": [
    ...key("enter", { alt: true }),
    ...key("enter", { shift: true }),
  ],
  "message.steer": key("tab"),
  "pending.openConversation": key("o", { alt: true }),
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
