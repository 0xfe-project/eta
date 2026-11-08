import type { Locale, TuiConfig, TuiPaths } from "../config/types";
import type { ConnectionController, WireClient } from "../connection/types";
import type {
  PinnedTab,
  ShellContext,
  SlashCommand,
} from "../extensions/types";
import type { Session } from "./shell/session";

export interface ShellContextSources {
  controller: ConnectionController;
  paths: TuiPaths;
  commands: readonly SlashCommand[];
  /** In tab bar order: the rightmost is the last. */
  pinnedTabs: readonly PinnedTab[];
  session: Session;
  /** The shell this context belongs to (`SessionState.shell`). */
  shell: number;
  getConfig: () => TuiConfig;
  getLocale: () => Locale;
  editFile: ShellContext["editFile"];
  runInteractive: ShellContext["runInteractive"];
  ensureConfigFile: ShellContext["ensureConfigFile"];
  reloadConfig: ShellContext["reloadConfig"];
  reportFailure: ShellContext["reportFailure"];
  quit: ShellContext["quit"];
}

/**
 * The context object of one shell. Its fields read the current values each time, so a command
 * that keeps the context sees the settings, language and wire in effect after `/config` or a
 * reconnect. Its layers open in its own shell only.
 */
export function createShellContext(sources: ShellContextSources): ShellContext {
  const { controller, session } = sources;
  const ctx: ShellContext = {
    get wire(): WireClient {
      const wire = controller.getState().wire;
      if (!wire) throw new Error("There is no connection to a host yet");
      return wire;
    },
    connection: controller,
    get config() {
      return sources.getConfig();
    },
    paths: sources.paths,
    get locale() {
      return sources.getLocale();
    },
    commands: sources.commands,
    openLayer: (render) => session.openLayer(sources.shell, render),
    notify: session.notify,
    openTab: session.openTab,
    closeTab: session.closeTab,
    editFile: sources.editFile,
    runInteractive: sources.runInteractive,
    ensureConfigFile: sources.ensureConfigFile,
    reloadConfig: sources.reloadConfig,
    selectPinnedTab: (id) => {
      const pinned =
        id === undefined
          ? sources.pinnedTabs.at(-1)
          : sources.pinnedTabs.find((p) => p.id === id);
      pinned?.onSelect(ctx);
    },
    reportFailure: sources.reportFailure,
    quit: sources.quit,
  };
  return ctx;
}
