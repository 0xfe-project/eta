import type { UseMutationResult } from "@tanstack/react-query";
import type { TargetState, WireState } from "@/lib/wire";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "zustand";
import { translate } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import { getWire, WireError } from "@/lib/wire";

// The wire in React: the connection's state, a target's state, and calls. Each target gets a few
// hooks of its own on top of these (queries/providers.ts is the first); this is the part they
// share.

/** Read the connection's store: status, ops, mounted plugins, targets. */
export function useWireState<T>(selector: (state: WireState) => T): T {
  return useStore(getWire().store, selector);
}

/** Whether the connection dropped and has not come back yet. */
export function useConnectionLost(): boolean {
  return useWireState((state) => state.status === "reconnecting");
}

/**
 * A target's state, and the subscription that keeps it current: the first component to read a
 * target subscribes, the last one to unmount unsubscribes. Eager targets (the ones `hello`
 * carries) show at once; the rest are undefined until their first snapshot.
 */
export function useTarget(target: string | undefined): TargetState | undefined {
  const wire = getWire();
  useEffect(
    () => (target === undefined ? undefined : wire.subscribe(target)),
    [wire, target],
  );
  return useStore(wire.store, (state) =>
    target === undefined ? undefined : state.targets[target],
  );
}

/**
 * Whether the host said there is nothing behind a target's name (`target:missing`): a task or a
 * routine that does not exist, or was deleted while its page was open. Read it next to
 * `useTarget`, which is what subscribes.
 */
export function useTargetMissing(target: string | undefined): boolean {
  return useWireState(
    (state) => target !== undefined && state.missing[target] === true,
  );
}

/**
 * Why a plugin's targets will not come: the host does not have the plugin, or it failed to load.
 * Undefined while the connection is still being made, and when all is well.
 */
function usePluginError(name: string): Error | undefined {
  const failure = useWireState((state) => {
    if (state.status !== "open") return undefined;
    const plugin = state.mounted.find((entry) => entry.name === name);
    return plugin === undefined || plugin.error !== undefined
      ? (plugin?.error ?? translate("common:errors.pluginMissing", { name }))
      : undefined;
  });
  return failure === undefined ? undefined : new Error(failure);
}

const NONE: never[] = [];

/**
 * The `list` section of a product target (`agents`, `machines`, `projects`, `conversations`),
 * kept live. `items` is the same empty array until the list arrives, so a memo on it holds;
 * `error` is set when the host cannot serve the target at all, instead of a list that never comes.
 */
export function useListTarget<T>(target: string): {
  items: readonly T[];
  loaded: boolean;
  error: Error | undefined;
} {
  const list = useTarget(target)?.sections.list as readonly T[] | undefined;
  const failure = usePluginError(target);
  return {
    items: list ?? NONE,
    loaded: list !== undefined,
    error: list === undefined ? failure : undefined,
  };
}

/**
 * `target.action` as a mutation: `mutate(args)` calls it, `isPending` is the wait for the reply,
 * and a failure is a `WireError` (see `wireErrorMessage`). The calls and results are typed by the
 * caller, because the wire itself knows no vocabulary.
 */
export function useWireMutation<Args = void, Result = unknown>(
  target: string,
  action: string,
  { onSuccess, ...call }: WireMutationOptions<Args, Result> = {},
): UseMutationResult<Result, Error, Args> {
  return useMutation<Result, Error, Args>({
    mutationKey: ["wire", target, action],
    mutationFn: (args) => getWire().call<Result>(target, action, args, call),
    ...(onSuccess === undefined ? {} : { onSuccess }),
  });
}

interface WireMutationOptions<Args, Result> {
  timeoutMs?: number;
  /** Runs for every call of the mutation that succeeds, whoever made it. */
  onSuccess?: (result: Result, args: Args) => void;
}

/** What to tell the user about a failed call: the host's own words, or what the wire lost. */
export function wireErrorMessage(error: unknown): string {
  if (error instanceof WireError) {
    if (error.code === "disconnected")
      return translate("common:errors.disconnected");
    if (error.code === "timeout") return translate("common:errors.timeout");
    // A failure the host explains with a code is told in the user's language.
    if (error.problem !== undefined)
      return llmProblemText({
        code: error.problem.code,
        message: error.message,
        params: error.problem.params,
      });
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : translate("common:errors.requestFailed");
}
