/**
 * The environment the packaged app starts its host with: its own, with the host's own bin
 * directories ahead of PATH, and with the user names macOS may have left out (`./user-env.ts`).
 *
 * This is the environment the host and every CLI it runs inherit, so it is the one place the two
 * are put right.
 */
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { userNames } from "./user-env";

export function hostEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const { PATH } = env;
  const paths =
    process.platform === "win32"
      ? []
      : [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return {
    ...env,
    ...userNames(env),
    PATH: [...paths, PATH].filter(Boolean).join(delimiter),
  };
}
