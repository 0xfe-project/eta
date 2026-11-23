/**
 * The environment the source entry (`index.ts`) starts its host with.
 *
 * It is the host's environment for as long as the host lives, and the host hands it on to every CLI
 * an agent starts, so the two things the app has to put right are put right here.
 *
 * The user names are `./host-env.ts`'s concern too, and for the same reason: an app opened from the
 * Dock can be given an environment with neither `USER` nor `LOGNAME`, and Claude Code then reports
 * that it is not logged in when the login has been there all along. The PATH is not: the packaged
 * launcher puts the host's own bin directories ahead of it, while this entry only takes the login
 * shell's PATH when one was asked for (`loginShellPath`, and only when packaged). Passing no path
 * leaves PATH exactly as it was inherited.
 *
 * A plain function over an environment, so a test can drive the whole decision without a window.
 */
import process from "node:process";
import { userNames } from "./user-env";

export function launchEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  path?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...userNames(env),
    ...(path === undefined ? {} : { PATH: path }),
  };
}
