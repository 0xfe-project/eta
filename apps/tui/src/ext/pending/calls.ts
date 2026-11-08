/**
 * The calls the pending feature makes for an item, kept per connection rather than per layer: an
 * item opened again while its call is on its way shows that call and does not send a second one,
 * and a call that settles after its layer closed still reaches the user.
 */
import type { StoreApi } from "zustand/vanilla";
import type { WireClient } from "../../connection/types";
import { createStore } from "zustand/vanilla";

/** Every field is by item key. */
export interface CallsState {
  /** An item with a call on its way. */
  sending: Readonly<Record<string, true>>;
  /**
   * An item a call of ours took out of what waits (an answer, or a task accepted as done): it going
   * from the lists is our doing, not someone else's. A comment leaves the item waiting, so it is
   * not marked.
   */
  ours: Readonly<Record<string, true>>;
  /** How many calls for the item landed; a layer showing the item closes when this grows. */
  landed: Readonly<Record<string, number>>;
  /** The item's last failure and its number in `failures`, until its next call starts. */
  errors: Readonly<Record<string, { message: string; number: number }>>;
  /** How many calls failed on this connection: a layer shows only the failures after it opened. */
  failures: number;
  /** How many layers show the item now. */
  shown: Readonly<Record<string, number>>;
}

const stores = new WeakMap<WireClient, StoreApi<CallsState>>();

export function callsFor(wire: WireClient): StoreApi<CallsState> {
  let store = stores.get(wire);
  if (store === undefined) {
    store = createStore<CallsState>(() => ({
      sending: {},
      ours: {},
      landed: {},
      errors: {},
      failures: 0,
      shown: {},
    }));
    stores.set(wire, store);
  }
  return store;
}

function without<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/** Counts a layer showing the item; returns the count's release. */
export function showItem(store: StoreApi<CallsState>, key: string): () => void {
  const by = (step: number) =>
    store.setState((s) => ({
      shown: { ...s.shown, [key]: (s.shown[key] ?? 0) + step },
    }));
  by(1);
  return () => by(-1);
}

export interface CallRequest {
  wire: WireClient;
  key: string;
  target: string;
  action: string;
  args: unknown;
  /** Whether the call, once it lands, takes the item out of what waits. */
  leaves: boolean;
  /** After the call landed, whether or not a layer shows the item. */
  onLanded: (result: unknown) => void;
  /**
   * After the call failed. `shown` says whether a layer shows the item, to tell the user there
   * when none does.
   */
  onFailed: (message: string, shown: boolean) => void;
}

/** Starts the item's call unless one is on its way already; returns whether it started. */
export function startCall(request: CallRequest): boolean {
  const { wire, key } = request;
  const store = callsFor(wire);
  if (store.getState().sending[key]) return false;
  store.setState((s) => ({
    sending: { ...s.sending, [key]: true },
    errors: without(s.errors, key),
  }));
  wire.call(request.target, request.action, request.args).then(
    (result) => {
      store.setState((s) => ({
        sending: without(s.sending, key),
        ours: request.leaves ? { ...s.ours, [key]: true } : s.ours,
        landed: { ...s.landed, [key]: (s.landed[key] ?? 0) + 1 },
      }));
      request.onLanded(result);
    },
    (failure: unknown) => {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      store.setState((s) => ({
        sending: without(s.sending, key),
        errors: { ...s.errors, [key]: { message, number: s.failures + 1 } },
        failures: s.failures + 1,
      }));
      request.onFailed(message, (store.getState().shown[key] ?? 0) > 0);
    },
  );
  return true;
}
