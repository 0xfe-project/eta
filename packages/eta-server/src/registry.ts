/**
 * The target registry: what can be asked, and what can be watched (SERVER-REFACTOR.md §3/§4).
 *
 * A *target* is a name a client addresses — `sessions`, `sessions.<id>`, `git`, `ssh`.
 * A target owns two optional things:
 *
 * - **actions**: `handle("sessions", "prompt", handler, { schema, description })` makes
 *   `sessions.prompt` callable;
 * - **state**: `state("sessions", project, { eager })` makes it subscribable, and (with
 *   `eager`) part of `hello` so a fresh client can draw before asking for anything.
 *
 * Nothing here knows a feature name. The floor does not register anything; bundled plugins
 * register `sessions.*`, user plugins register their own, and the difference between them is
 * only which way they were loaded. That is what makes the server a pipe.
 *
 * Two rules keep it predictable:
 *
 * - **An unknown call is an error naming what was asked for** (`unknown op: sessions.promt`),
 *   because with no shared vocabulary a typo has to fail loudly somewhere.
 * - **A registration is an effect**: every `handle`/`state` returns a disposer, so unloading
 *   a plugin takes its actions and its state with it — and a client learns that the panel is
 *   gone because the target's state stops moving and disappears from `hello`.
 */
import type {
  CallFrame,
  OpDescriptor,
  StateSnapshot,
} from "@eta/client-wire-proto";
import type {
  DispatchOutcome,
  OpContext,
  OpHandler,
  OpMeta,
  StateProjector,
} from "@eta/plugin-sdk";

export type {
  DispatchOutcome,
  OpContext,
  OpHandler,
  OpMeta,
  StateProjector,
} from "@eta/plugin-sdk";

export interface TargetSummary {
  name: string;
  hasState: boolean;
  eager: boolean;
  actions: string[];
}

export interface TargetRegistry {
  /** Register one action a target can be asked to perform. */
  handle: (
    target: string,
    action: string,
    handler: OpHandler,
    meta?: OpMeta,
  ) => () => void;
  /** Register one target's state. */
  state: (target: string, projector: StateProjector) => () => void;
  /**
   * Take an action away, whoever registered it. For the floor's own use: a plugin that forgets
   * to unregister (a user plugin, not ours) must not leave a target behind that answers calls
   * with a dead handler. Returns whether anything was there.
   */
  unregister: (target: string, action: string) => boolean;
  /** Take a target's state away, whoever registered it. */
  unregisterState: (target: string) => boolean;
  /** Route one call. Throws `UnknownOpError` when nobody claims it. */
  dispatch: (call: CallFrame, context: OpContext) => Promise<DispatchOutcome>;
  /** Everything callable, as `hello` publishes it. */
  descriptors: () => OpDescriptor[];
  /** Every target and what it offers. */
  targets: () => TargetSummary[];
  hasState: (target: string) => boolean;
  /** One target's current state, or undefined when the target shows nothing. */
  snapshot: (target: string) => StateSnapshot | undefined;
  /** The targets a new client should be given up front. */
  eagerTargets: () => string[];
}

export class UnknownOpError extends Error {
  readonly target: string;
  readonly action: string;
  constructor(target: string, action: string) {
    super(`unknown op: ${target}.${action}`);
    this.name = "UnknownOpError";
    this.target = target;
    this.action = action;
  }
}

const NAME_PATTERN = /^[a-z0-9][\w.-]*$/i;

export function createTargetRegistry(): TargetRegistry {
  const actions = new Map<
    string,
    { target: string; action: string; handler: OpHandler; meta: OpMeta }
  >();
  const states = new Map<string, StateProjector>();

  const key = (target: string, action: string): string => `${target}.${action}`;
  const claim = (target: string, action: string): string => {
    if (!NAME_PATTERN.test(target))
      throw new Error(`invalid target name: ${JSON.stringify(target)}`);
    if (!NAME_PATTERN.test(action))
      throw new Error(`invalid action name: ${JSON.stringify(action)}`);
    const name = key(target, action);
    if (actions.has(name)) throw new Error(`op already registered: ${name}`);
    return name;
  };

  return {
    handle(target, action, handler, meta = {}): () => void {
      const name = claim(target, action);
      actions.set(name, { target, action, handler, meta });
      return () => {
        if (actions.get(name)?.handler === handler) actions.delete(name);
      };
    },

    state(target, projector): () => void {
      if (!NAME_PATTERN.test(target))
        throw new Error(`invalid target name: ${JSON.stringify(target)}`);
      if (states.has(target))
        throw new Error(`state already registered: ${target}`);
      states.set(target, projector);
      return () => {
        if (states.get(target) === projector) states.delete(target);
      };
    },

    unregister(target, action): boolean {
      return actions.delete(key(target, action));
    },

    unregisterState(target): boolean {
      return states.delete(target);
    },

    async dispatch(call, context): Promise<DispatchOutcome> {
      const entry = actions.get(key(call.target, call.action));
      if (entry === undefined)
        throw new UnknownOpError(call.target, call.action);
      return (await entry.handler(call, context)) ?? {};
    },

    descriptors(): OpDescriptor[] {
      return [...actions.entries()]
        .map(([name, entry]) => {
          return {
            name,
            target: entry.target,
            action: entry.action,
            ...(entry.meta.description === undefined
              ? {}
              : { description: entry.meta.description }),
            ...(entry.meta.schema === undefined
              ? {}
              : { schema: entry.meta.schema }),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    targets(): TargetSummary[] {
      const names = new Set<string>([
        ...states.keys(),
        ...[...actions.values()].map((entry) => entry.target),
      ]);
      return [...names].sort().map((name) => ({
        name,
        hasState: states.has(name),
        eager: states.get(name)?.eager === true,
        actions: [...actions.values()]
          .filter((entry) => entry.target === name)
          .map((entry) => entry.action)
          .sort(),
      }));
    },

    hasState(target): boolean {
      return states.has(target);
    },

    snapshot(target): StateSnapshot | undefined {
      // A projector that throws does not take the pipe down: the client gets a state
      // whose section says what broke, and everything else keeps working.
      try {
        return states.get(target)?.project();
      } catch (error) {
        return {
          sections: {
            error: {
              message: error instanceof Error ? error.message : String(error),
            },
          },
          revisions: { error: String(error) },
        };
      }
    },

    eagerTargets(): string[] {
      return [...states.entries()]
        .filter(([, projector]) => projector.eager === true)
        .map(([name]) => name)
        .sort();
    },
  };
}
