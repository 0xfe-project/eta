/**
 * USER and LOGNAME, for a process that was started without them.
 *
 * An app opened from the Dock is not always given a user environment: launchd can hand a process
 * one with no `USER` and no `LOGNAME`. That environment is passed on to everything the app starts
 * — `scripts/nsh-host-bootstrap.ts` builds it for the host, and through the host every CLI an agent
 * starts — so a name missing at the start is missing there.
 *
 * Claude Code is one of those CLI: it reported that it was not logged in when both names were
 * absent, and adding both restored a login that had been there all along.
 *
 * Only what is missing, and only on macOS: a name the environment already carries always wins, and
 * the platforms that never lose these names keep their behaviour.
 */
import process from "node:process";

/** The login name of the user this process runs as, or null where it cannot be read. */
export function accountName(
  platform: NodeJS.Platform = process.platform,
): string | null {
  // Only macOS is known to hand a Dock-launched app an environment without these two.
  if (platform !== "darwin") return null;
  // Not `userInfo()`: with `$USER` unset it answers the literal string "unknown" (bun 1.4.4) — this
  // very case, and a name no login owns. `id -un` asks libc, which asks the password database.
  try {
    const id = Bun.spawnSync(["/usr/bin/id", "-un"], {
      stdin: "ignore",
      stderr: "ignore",
    });
    return accountFrom(id);
  } catch {
    // `Bun.spawnSync` throws when the binary cannot be spawned at all; a name is not worth the host
    // failing to start over.
    return null;
  }
}

/** The name in what `id -un` printed: only from a run that succeeded and said something. */
export function accountFrom(result: {
  exitCode: number | null;
  stdout: Uint8Array | string;
}): string | null {
  if (result.exitCode !== 0) return null;
  const name = result.stdout.toString().trim();
  return name === "" ? null : name;
}

export function userNames(
  env: NodeJS.ProcessEnv = process.env,
  name?: string | null,
): NodeJS.ProcessEnv {
  // Destructured rather than read as a property: `process.env` is an index signature.
  const { USER, LOGNAME } = env;
  if (USER && LOGNAME) return {};
  const login = name === undefined ? accountName() : name;
  if (!login) return {};
  return {
    ...(USER ? {} : { USER: login }),
    ...(LOGNAME ? {} : { LOGNAME: login }),
  };
}
