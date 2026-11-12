import type { ConnectionState, WireClient } from "../../connection/types";
import type { ShellContext } from "../../extensions/types";

/**
 * The wire a shell shows for in this state, by the App's rule: a shell lasts while the
 * connection is connecting, connected or reconnecting on the same wire, and any other phase or
 * another wire ends it.
 */
function shellWireOf(state: ConnectionState): WireClient | undefined {
  switch (state.phase.name) {
    case "connecting":
    case "connected":
    case "reconnecting":
      return state.wire;
    default:
      return undefined;
  }
}

/** The shell a command started in, watched from then on. */
export interface ShellWatch {
  /**
   * The command's context with its wire fixed to the one of that shell: calls never reach a host
   * the connection moved to later. Everything else reads through to the context.
   */
  ctx: ShellContext;
  /**
   * Whether that shell has ended. Once it has, this stays true: a later shell, even on the same
   * host, is another shell, and the command's context opens no layers there.
   */
  ended: () => boolean;
  stop: () => void;
}

/** Watches the shell showing now; call it before the command's first await. */
export function watchShell(ctx: ShellContext): ShellWatch {
  const startWire = shellWireOf(ctx.connection.getState());
  let ended = startWire === undefined;
  const stop = ctx.connection.subscribe(() => {
    if (shellWireOf(ctx.connection.getState()) !== startWire) ended = true;
  });
  const pinned = Object.create(ctx, {
    wire: {
      get: (): WireClient => {
        if (startWire === undefined)
          throw new Error("There is no connection to a host");
        return startWire;
      },
    },
  }) as ShellContext;
  return { ctx: pinned, ended: () => ended, stop };
}
