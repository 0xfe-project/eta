import type { TuiPaths } from "./types";
import { posix, win32 } from "node:path";

const CONFIG_NAME = "tui.json";
const STATE_NAME = "tui-state.json";

/**
 * Where the settings and state files are: `ETA_TUI_CONFIG` when set, else the platform's
 * per-user configuration directory (`%APPDATA%\eta` on Windows, `$XDG_CONFIG_HOME/eta` or
 * `~/.config/eta` elsewhere). The state file is always beside the settings file.
 */
export function resolvePaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): TuiPaths {
  const path = platform === "win32" ? win32 : posix;
  const config = configFile(env, platform, home);
  return { config, state: path.join(path.dirname(config), STATE_NAME) };
}

function configFile(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  const path = platform === "win32" ? win32 : posix;
  const given = env.ETA_TUI_CONFIG;
  if (given !== undefined && given !== "") return path.resolve(given);
  if (platform === "win32") {
    const appData = env.APPDATA;
    const roaming =
      appData !== undefined && appData !== ""
        ? appData
        : win32.join(home, "AppData", "Roaming");
    return win32.join(roaming, "eta", CONFIG_NAME);
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg !== "" && posix.isAbsolute(xdg)
      ? xdg
      : posix.join(home, ".config");
  return posix.join(base, "eta", CONFIG_NAME);
}
