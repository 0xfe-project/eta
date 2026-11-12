import type { HostProgram } from "./types";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

const PROGRAM = "eta-host";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// A copy of the Windows environment is a plain object, so the casing of `Path` survives in it.
function pathVariable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  if (platform !== "win32") return env.PATH ?? "";
  const name = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  return name === undefined ? "" : (env[name] ?? "");
}

/**
 * Where `eta-host` is: `ETA_HOST_BIN`, else `eta-host` on `PATH`, else `~/.eta/bin/eta-host`
 * (`eta-host.exe` on Windows). A non-empty `ETA_HOST_BIN` is the only place looked at: when it
 * names no file the answer is undefined, not a program found elsewhere.
 */
export function findHostProgram(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}): HostProgram | undefined {
  const { env, platform, home } = options;
  const pinned = env.ETA_HOST_BIN;
  if (pinned !== undefined && pinned !== "")
    return isFile(pinned) ? { command: pinned, args: [] } : undefined;
  const onPath = Bun.which(PROGRAM, { PATH: pathVariable(env, platform) });
  if (onPath !== null) return { command: onPath, args: [] };
  const path = platform === "win32" ? win32 : posix;
  const installed = path.join(
    home,
    ".eta",
    "bin",
    platform === "win32" ? `${PROGRAM}.exe` : PROGRAM,
  );
  return isFile(installed) ? { command: installed, args: [] } : undefined;
}
