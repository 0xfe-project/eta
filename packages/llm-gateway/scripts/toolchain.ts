/** Build PATH entries for tools that Windows installs outside the current shell. */
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import process from "node:process";

function windowsToolDirs(): string[] {
  const dirs = ["C:\\Program Files\\Go\\bin"];
  const packages = process.env.LOCALAPPDATA;
  if (packages === undefined) return dirs;

  const winget = join(packages, "Microsoft", "WinGet", "Packages");
  if (!existsSync(winget)) return dirs;
  for (const entry of readdirSync(winget)) {
    if (!entry.startsWith("BrechtSanders.WinLibs.")) continue;
    dirs.push(join(winget, entry, "mingw64", "bin"));
  }
  return dirs;
}

/** The current environment with common compiler locations prepended when present. */
export function toolEnvironment(): NodeJS.ProcessEnv {
  const fixed =
    process.platform === "win32"
      ? windowsToolDirs()
      : ["/usr/local/go/bin", "/opt/homebrew/bin", "/usr/local/bin"];
  const path = [...fixed.filter((entry) => existsSync(entry)), process.env.PATH]
    .filter((entry): entry is string => entry !== undefined && entry !== "")
    .join(delimiter);
  return { ...process.env, PATH: path };
}
