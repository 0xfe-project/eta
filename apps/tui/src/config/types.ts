/**
 * The TUI's own files: what the user writes (`tui.json`) and what the TUI writes for itself
 * (`tui-state.json`), as the rest of the program sees them once read.
 */

/** The interface languages. */
export type Locale = "en" | "zh";

/** Everything a key can be bound to. A view binds its keys by these names, never by the key. */
export const ACTION_NAMES = [
  "tabs.previous",
  "tabs.next",
  "tabs.goTo1",
  "tabs.goTo2",
  "tabs.goTo3",
  "tabs.goTo4",
  "tabs.goTo5",
  "tabs.goTo6",
  "tabs.goTo7",
  "tabs.goTo8",
  "tabs.goTo9",
  /** The list panel at the right end of the tab bar; bound to a key only an empty input sees. */
  "panel.open",
  "review.open",
  /** Closes the tab, not the conversation. */
  "tabs.close",
  /** Stops the reply of the conversation on screen, while one is running. */
  "reply.stop",
  /** Quits on the second press in a row. */
  "app.quit",
  /** Scroll the conversation on screen by a page, a line, or to either end. */
  "transcript.pageUp",
  "transcript.pageDown",
  "transcript.lineUp",
  "transcript.lineDown",
  "transcript.top",
  "transcript.bottom",
  /** Find text in the conversation on screen. */
  "transcript.search",
  /** Move a cursor over the conversation's lines to select, copy and fold them. */
  "transcript.select",
  /** Unfold, or fold again, every thinking block and long tool output of the conversation. */
  "transcript.expandAll",
  /** A new line in the message being written, instead of sending it. */
  "message.newline",
  /** Send the message into the reply that is running, instead of queueing it after. */
  "message.steer",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

/** Keys a binding names by word; anything else is one printable character. */
export const NAMED_KEYS = [
  "left",
  "right",
  "up",
  "down",
  "escape",
  "enter",
  "tab",
  "backspace",
  "delete",
  "pageup",
  "pagedown",
  "home",
  "end",
  "space",
] as const;

export type NamedKey = (typeof NAMED_KEYS)[number];

/** One key with its modifiers, parsed from text such as `alt+left` or `ctrl+c`. */
export interface KeyBinding {
  /** A named key, or a single printable character in lower case. */
  key: NamedKey | (string & {});
  ctrl: boolean;
  /** Alt, which terminals send as meta. */
  alt: boolean;
  shift: boolean;
}

/** The colour slots the interface paints with; each value is an Ink colour. */
export const THEME_TOKENS = [
  /** The start of the logo's gradient. */
  "brand",
  /** The end of the logo's gradient. */
  "brandDim",
  "text",
  "muted",
  "accent",
  "warning",
  "error",
  "success",
  "border",
  "selection",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export type Theme = Record<ThemeToken, string>;

/** Which host to use: one that runs on its own at an address, or one this TUI starts and stops. */
export type ConnectionSetting =
  | {
      mode: "resident";
      /** The host's HTTP base, `http(s)://host:port`, without a path. */
      url: string;
      token?: string;
    }
  | { mode: "temporary" };

/** The settings in effect: the user's values over the defaults, key by key. */
export interface TuiConfig {
  /** Absent: chosen from the environment's locale. */
  locale: Locale | undefined;
  /** Absent: the first start asks. */
  connection: ConnectionSetting | undefined;
  /** Where `ssh -t` opens the host's own files when the host is remote. */
  ssh: { target: string | undefined };
  theme: Theme;
  keybindings: Record<ActionName, KeyBinding[]>;
  layout: { tabBar: "bottom" | "top" };
  /** How many lines of a long tool output show before it is expanded. */
  toolOutput: { previewLines: number };
}

export type ConfigProblemReason =
  | "unreadable"
  | "invalid-json"
  | "not-an-object"
  | "wrong-type"
  | "invalid-value"
  | "unknown-key";

/** Something in the settings file that was not used; its default stands in. */
export interface ConfigProblem {
  file: string;
  /** Dotted path of the key, such as `keybindings.tabs.next`; empty for the whole file. */
  key: string;
  reason: ConfigProblemReason;
  /** What was found or what went wrong, for the message. */
  detail?: string;
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: TuiConfig;
  problems: ConfigProblem[];
}

/** Where the two files are. Both live in one directory. */
export interface TuiPaths {
  config: string;
  state: string;
}

/** An open tab: what kind of view draws it, and which thing it shows. */
export interface TabRef {
  kind: string;
  id: string;
}

/** What the TUI remembers between runs. */
export interface TuiState {
  tabs: TabRef[];
  /** Index into `tabs`; absent when the home screen is in front. */
  activeTab: number | undefined;
}

/** Why the settings file could not be written; the change stays in memory. */
export type SaveProblem =
  | { reason: "invalid-json"; file: string }
  | { reason: "io"; file: string; detail: string };
