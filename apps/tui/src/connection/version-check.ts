import type { VersionWarning } from "./types";

/** A source build says `dev`, and its version says nothing about what it can do. */
const SOURCE_BUILD = "dev";

/** The warning for a host whose build differs from this TUI's; none when either runs from source. */
export function versionWarning(
  host: string,
  tui: string,
): VersionWarning | undefined {
  if (host === SOURCE_BUILD || tui === SOURCE_BUILD || host === tui)
    return undefined;
  return { host, tui };
}
