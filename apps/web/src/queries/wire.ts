import type { UseMutationResult } from "@tanstack/react-query";
import type { TargetState, WireState } from "@/lib/wire";
import { useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { useStore } from "zustand";
import { translate } from "@/lib/i18n";
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
export function useTarget(target: string): TargetState | undefined {
  const wire = getWire();
  useEffect(() => wire.subscribe(target), [wire, target]);
  return useStore(wire.store, (state) => state.targets[target]);
}

/**
 * `target.action` as a mutation: `mutate(args)` calls it, `isPending` is the wait for the reply,
 * and a failure is a `WireError` (see `wireErrorMessage`). The calls and results are typed by the
 * caller, because the wire itself knows no vocabulary.
 */
export function useWireMutation<Args = void, Result = unknown>(
  target: string,
  action: string,
  options: { timeoutMs?: number } = {},
): UseMutationResult<Result, Error, Args> {
  return useMutation<Result, Error, Args>({
    mutationKey: ["wire", target, action],
    mutationFn: (args) => getWire().call<Result>(target, action, args, options),
  });
}

/** What to tell the user about a failed call: the host's own words, or what the wire lost. */
export function wireErrorMessage(error: unknown): string {
  if (error instanceof WireError) {
    if (error.code === "disconnected")
      return translate("common:errors.disconnected");
    if (error.code === "timeout") return translate("common:errors.timeout");
    return error.message;
  }
  return error instanceof Error
    ? error.message
    : translate("common:errors.requestFailed");
}
