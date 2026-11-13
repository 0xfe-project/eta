import type { ConnectionPhase } from "../../connection/types";
import { isLoopbackHostname } from "../kit/connection";

/**
 * Whether the host runs on this computer: a temporary host (this TUI started it), or an address
 * whose host name is a loopback one (`127.0.0.0/8`, `localhost`, `::1`). Phases without an
 * address are not.
 */
export function isLocalHost(phase: ConnectionPhase): boolean {
  if (!("url" in phase) || phase.url === undefined) return false;
  if ("temporary" in phase && phase.temporary) return true;
  let hostname: string;
  try {
    hostname = new URL(phase.url).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname);
}

/**
 * The home directory as `os.homedir()` finds it for this environment: `USERPROFILE` on Windows,
 * `HOME` elsewhere, and `fallback()` when that variable is unset or empty.
 */
export function homeOf(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fallback: () => string,
): string {
  const value = platform === "win32" ? env.USERPROFILE : env.HOME;
  return value === undefined || value === "" ? fallback() : value;
}
