import type { AskObserver, EsmAuthorizer } from "@eta/harness";
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
  realmAuthorizer?: NonNullable<SessionManagerOptions["realmAuthorizer"]>;
  askObserve?: NonNullable<SessionManagerOptions["askObserve"]>;
  sessionAttach?: NonNullable<SessionManagerOptions["sessionAttach"]>;
}

/**
 * Many features, one set of manager hooks. Tools and middleware are concatenated in list order
 * (so middleware runs in the order the features are listed), realm authorizers are asked in the
 * same order until one refuses, and every observer hears every question of a session it observes.
 */
export function combineSessionHooks(
  parts: readonly SessionHooks[],
): Required<SessionHooks> {
  return {
    sessionTools: (input) =>
      parts.flatMap((part) => part.sessionTools?.(input) ?? []),
    toolMiddleware: (input) =>
      parts.flatMap((part) => part.toolMiddleware?.(input) ?? []),
    realmAuthorizer: (input) => {
      const authorizers = parts
        .map((part) => part.realmAuthorizer?.(input))
        .filter(
          (authorizer): authorizer is EsmAuthorizer => authorizer !== undefined,
        );
      if (authorizers.length === 0) return undefined;
      // Synchronous for as long as every answer is, so a sync binding is only refused when one
      // of them really has to wait.
      const from =
        (index: number): EsmAuthorizer =>
        (request, call) => {
          for (let i = index; i < authorizers.length; i++) {
            const verdict = authorizers[i]!(request, call);
            if (verdict === undefined) continue;
            if (typeof verdict === "string") return verdict;
            return verdict.then((reason) =>
              reason === undefined ? from(i + 1)(request, call) : reason,
            );
          }
          return undefined;
        };
      return from(0);
    },
    sessionAttach: async (input) => {
      for (const part of parts) await part.sessionAttach?.(input);
    },
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
