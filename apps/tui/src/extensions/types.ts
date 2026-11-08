/**
 * How a feature plugs into the TUI. A feature is one module under `src/ext/` whose default export
 * is an `Extension`; the build collects every module there, so adding a feature adds a file and
 * edits none.
 */
import type { ComponentType, ReactNode } from "react";
import type {
  ConfigProblem,
  Locale,
  SaveProblem,
  TabRef,
  TuiConfig,
  TuiPaths,
} from "../config/types";
import type { ConnectionController, WireClient } from "../connection/types";

/** A text in both interface languages. */
export interface Localized {
  en: string;
  zh: string;
}

/**
 * A feature's interface texts: the same keys in both languages. A value may hold `{name}`
 * placeholders, and both languages use the same ones.
 */
export interface MessageCatalog<K extends string = string> {
  en: Record<K, string>;
  zh: Record<K, string>;
}

export interface CommandArg {
  /** English, as typed. */
  name: string;
  required: boolean;
  summary: Localized;
}

export interface CommandExample {
  /** What the user types, such as `/help model`. */
  input: string;
  summary: Localized;
}

/** A slash command. Its name and arguments are English only; what it says about itself is in both languages. */
export interface SlashCommand {
  /** Without the slash: lower-case letters, digits and `-`, starting with a letter. */
  name: string;
  args: CommandArg[];
  summary: Localized;
  examples: CommandExample[];
  /** The ops it calls. When the host lacks one, the command is refused as too new for that host. */
  requiredOps: string[];
  /** `argText` is everything after the name, trimmed. */
  run: (ctx: ShellContext, argText: string) => void | Promise<void>;
}

export type TabStatus = "running" | "waiting" | "done" | "failed";

/** Draws the tabs of one kind in the main area, and names them in the tab bar. */
export interface TabView {
  kind: string;
  Component: ComponentType<{ tab: TabRef; active: boolean }>;
  /** A hook: the tab's name in the tab bar. */
  useTitle: (tab: TabRef) => string;
  /** A hook: the tab's status mark; undefined draws none. */
  useStatus?: (tab: TabRef) => TabStatus | undefined;
}

/** A fixed entry at the right end of the tab bar, after the open tabs. */
export interface PinnedTab {
  id: string;
  /** A hook: the entry's text. */
  useLabel: () => string;
  onSelect: (ctx: ShellContext) => void;
}

export interface Extension {
  /** Unique among extensions; the module's file name. */
  id: string;
  messages?: MessageCatalog;
  commands?: SlashCommand[];
  views?: TabView[];
  pinnedTabs?: PinnedTab[];
  /** After every hello; `first` on the first one of this run. */
  onConnected?: (ctx: ShellContext, first: boolean) => void | Promise<void>;
  /**
   * Mounted for as long as the shell shows, inside it, and drawn nowhere: the place for keys
   * that work on every screen of the shell (`useAction`). A layer over the main area or the
   * reconnecting screen turns its keys off; it is unmounted when the shell goes away.
   */
  Background?: ComponentType;
}

export interface LayerHandle {
  close: () => void;
}

export type NoticeTone = "info" | "warning" | "error";

/** What a command, a view or an extension can ask of the running TUI. */
export interface ShellContext {
  readonly wire: WireClient;
  readonly connection: ConnectionController;
  /** The settings in effect now. */
  readonly config: TuiConfig;
  readonly paths: TuiPaths;
  readonly locale: Locale;
  /** Every slash command, sorted by name. */
  readonly commands: readonly SlashCommand[];
  /**
   * Put something over the main area until the handle is closed. Layers stack. They belong to the
   * shell: when it goes away (the connection is lost for good, refused, or replaced), every layer
   * is closed.
   *
   * A context belongs to the shell of one connection, from the connection's first attempt until
   * that shell goes away. After that, this context's `openLayer` opens nothing, also while a later
   * shell shows, and returns a handle whose `close` does nothing. A layer opened before the shell
   * first shows (from `onConnected`) appears when it does.
   */
  openLayer: (render: (handle: LayerHandle) => ReactNode) => LayerHandle;
  /** A short line in the status area. */
  notify: (text: string, tone?: NoticeTone) => void;
  /** The tab in front now; undefined while the home screen is. */
  readonly activeTab: TabRef | undefined;
  /** Open a tab, or bring it to the front when it is open. */
  openTab: (tab: TabRef) => void;
  closeTab: (tab: TabRef) => void;
  /** Hand the terminal to the user's editor on this file and take it back when the editor exits. */
  editFile: (path: string) => Promise<{ exitCode: number | null }>;
  /** Hand the terminal to any interactive program (`ssh -t …`) and take it back when it exits. */
  runInteractive: (
    command: string,
    args: string[],
  ) => Promise<{ exitCode: number | null }>;
  /** Create the settings file with an empty object when it is missing; returns why it could not be written. */
  ensureConfigFile: () => Promise<SaveProblem | undefined>;
  /** Read the settings file again and apply it; returns what in it was not used. */
  reloadConfig: () => Promise<ConfigProblem[]>;
  /** Run the `onSelect` of the pinned tab with this id, or of the rightmost one; nothing when there is none. */
  selectPinnedTab: (id?: string) => void;
  /**
   * Show the failure of an action started outside a command's `run` (from a layer, a key or a
   * view) in the status area, instead of letting it go unhandled. A task that succeeds shows nothing.
   */
  reportFailure: (task: Promise<unknown>) => void;
  /** Stop the temporary host if there is one, leave the alternate screen, exit. */
  quit: () => Promise<void>;
}
