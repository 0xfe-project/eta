// Ported from pi-mcp-adapter/npx-resolver.ts (MIT, see ../../NOTICE); bunx and uvx follow the same idea.
/**
 * Launch acceleration: `npx`, `npm exec`, `bunx`, `bun x`, `uvx` and `uv tool run` start the
 * executable of an already-installed package directly. Anything unrecognised, anything not
 * installed yet and any error leave the original command as it was.
 */
import type { LaunchCommand, ResolverEnv } from "./shared";
import { resolveBunx } from "./bunx";
import { resolveNpx } from "./npx";
import { resolveUvx } from "./uvx";

export type { LaunchCommand, ResolverEnv } from "./shared";

/** The command to start in place of `command args`, or the same pair when nothing better is known. */
export async function resolveLaunch(
  command: string,
  args: readonly string[],
  env: ResolverEnv = {},
  signal?: AbortSignal,
): Promise<LaunchCommand> {
  const original: LaunchCommand = { command, args: [...args] };
  try {
    switch (command) {
      case "npx":
      case "npm":
        return (
          (await resolveNpx(command, original.args, env, signal)) ?? original
        );
      case "bunx":
      case "bun":
        return resolveBunx(command, original.args, env) ?? original;
      case "uvx":
      case "uv":
        return resolveUvx(command, original.args, env) ?? original;
      default:
        return original;
    }
  } catch {
    // Resolution is an optimisation. Whatever went wrong, the original command still works.
    if (signal?.aborted) throw signal.reason;
    return original;
  }
}
