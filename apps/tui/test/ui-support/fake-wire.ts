/** A wire that never touches a network: its state is set by the test. */
import type { WireClient, WireState } from "../../src/connection/types";
import { createStore } from "zustand/vanilla";

export function fakeWire(
  initial: Partial<WireState> = {},
): WireClient & { calls: string[] } {
  const store = createStore<WireState>(() => ({
    status: "open",
    ops: [],
    mounted: [],
    targets: {},
    missing: {},
    error: undefined,
    ...initial,
  }));
  const calls: string[] = [];
  return {
    store,
    calls,
    can: (op) => store.getState().ops.includes(op),
    call: async (target, action) => {
      calls.push(`${target}.${action}`);
      return undefined as never;
    },
    subscribe: () => () => {},
    onEvent: () => () => {},
  };
}
