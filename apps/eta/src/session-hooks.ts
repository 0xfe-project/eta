import type { AskObserver } from "@eta/harness";
import type { SessionManagerOptions } from "@eta/server";

/**
 * What one product feature adds to the sessions it cares about: tools the model can call,
 * middleware on its tool calls, and an ear for its questions. Every field is optional, and a hook
 * that has nothing to say about a session returns nothing for it.
 *
 * The session manager takes one hook of each kind. Several features want each of them (the
 * conversation engine, the task board, memory, the approval list), so the product keeps a list of
 * these and hands the manager their combination.
 */
export interface SessionHooks {
  sessionTools?: NonNullable<SessionManagerOptions["sessionTools"]>;
  toolMiddleware?: NonNullable<SessionManagerOptions["toolMiddleware"]>;
  askObserve?: NonNullable<SessionManagerOptions["askObserve"]>;
}

/**
 * Many features, one set of manager hooks. Tools and middleware are concatenated in list order
 * (so middleware runs in the order the features are listed), and every observer hears every
 * question of a session it observes.
 */
export function combineSessionHooks(
  parts: readonly SessionHooks[],
): Required<SessionHooks> {
  return {
    sessionTools: (input) =>
      parts.flatMap((part) => part.sessionTools?.(input) ?? []),
    toolMiddleware: (input) =>
      parts.flatMap((part) => part.toolMiddleware?.(input) ?? []),
    askObserve: (meta) => {
      const observers = parts
        .map((part) => part.askObserve?.(meta))
        .filter((observer): observer is AskObserver => observer !== undefined);
      if (observers.length === 0) return undefined;
      return (action, payload) => {
        for (const observe of observers) observe(action, payload);
      };
    },
  };
}
