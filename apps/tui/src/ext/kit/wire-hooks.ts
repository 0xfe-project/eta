// Adapted from apps/web/src/queries/wire.ts: the wire's state in React, on the shell's wire.

import type { TargetState, WireState } from "../../connection/types";
import { useEffect } from "react";
import { useStore } from "zustand";
import { useShell } from "../../extensions/react";

/**
 * A slice of the wire's state; the component re-renders when the slice changes. The selector
 * must return the same value for the same state (a field, not a new object or array each time).
 *
 * It subscribes to nothing. The wire keeps a target's state current only while somebody has
 * subscribed to it, so reading `targets.x` here without a `useTarget("x")` mounted shows what
 * `hello` carried, or nothing, and never changes after. Read a target's sections with `useTarget`.
 */
export function useWireState<T>(selector: (state: WireState) => T): T {
  return useStore(useShell().wire.store, selector);
}

/**
 * A target's state, subscribed while the component is mounted and released when it unmounts.
 * Eager targets (those `hello` carries) show at once; the rest are undefined until their first
 * snapshot. `undefined` subscribes to nothing.
 */
export function useTarget(target: string | undefined): TargetState | undefined {
  const { wire } = useShell();
  useEffect(
    () => (target === undefined ? undefined : wire.subscribe(target)),
    [wire, target],
  );
  return useStore(wire.store, (state) =>
    target === undefined ? undefined : state.targets[target],
  );
}

/**
 * Whether the host lists the plugin in `hello.mounted`, and its load error when it failed to load.
 * A plugin that failed is still listed: `mounted` is true and `error` is set.
 */
export function useMounted(name: string): {
  mounted: boolean;
  error: string | undefined;
} {
  const plugin = useWireState((state) =>
    state.mounted.find((entry) => entry.name === name),
  );
  return { mounted: plugin !== undefined, error: plugin?.error };
}
