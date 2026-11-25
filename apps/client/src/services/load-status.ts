import type { EmptyStatus } from "../components/empty-state";
import { cleanup, effect, signal, untracked } from "nsh";
import { settled } from "../components/pending";
import { uiText } from "../i18n";
import { useHost } from "./host";

// Whether what a region reads has arrived, is still on its way, or did not come (#378), so its
// empty state can tell "nothing here yet" from "not loaded". The data and the subscriptions are
// the caller's as before; this only watches the host's state for them.

/** How long a region waits for what it reads before it says it did not load. */
export const LOAD_PATIENCE_MS = 15_000;

/** Why it did not come: the connection is down, the host has no such thing, the host answered
 * nothing in time, or the host cannot do this at all. */
type LoadFailure = "offline" | "missing" | "slow" | "unsupported";

export interface LoadState {
  /** `ready` once it is here; `loading` and `error` are an `EmptyState`'s. */
  status: () => "ready" | Exclude<EmptyStatus, "empty">;
  /** The same for an `EmptyState` shown when nothing is listed: `ready` is `empty`. */
  shown: () => EmptyStatus;
  failure: () => LoadFailure | undefined;
  /** Try again: reconnect, or ask the host once more; `retrying` until it lands or fails again. */
  retry: () => void;
  retrying: () => boolean;
  /** The failure in the user's words, for an `EmptyFailure`'s description. */
  why: () => string;
}

/**
 * Watch the host targets a region reads (`tasks`, `conversations.<id>`): ready once every one has
 * state (or `ready()` says so), failed when one is missing, when the connection is down before
 * they came, when `op` is not something this host can do, or after `LOAD_PATIENCE_MS`.
 */
export function useLoadState(options: {
  targets: () => readonly (string | undefined)[];
  ready?: () => boolean;
  op?: string;
}): LoadState {
  const host = useHost();
  const late = signal(false);
  const retrying = signal(false);
  const names = () => options.targets();
  const here = () => {
    if (options.ready) return options.ready();
    const list = names();
    return (
      list.length > 0 &&
      list.every((name) => name !== undefined && !!host.state().targets[name])
    );
  };
  const failure = (): LoadFailure | undefined => {
    if (here()) return undefined;
    const state = host.state();
    if (options.op && state.ops.length && !state.ops.includes(options.op))
      return "unsupported";
    if (names().some((name) => name !== undefined && state.missing[name]))
      return "missing";
    if (host.disconnected() || host.paused()) return "offline";
    if (late()) return "slow";
    return undefined;
  };
  // Once a skeleton appeared it stays its least time, whatever came (#380).
  const over = settled(() => here() || !!failure());
  const status = () =>
    !over() ? ("loading" as const) : here() ? "ready" : "error";

  // Patience runs while it is loading, from when it started to.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const key = () => names().join("|");
  effect(() => {
    key();
    const waiting = !here() && !host.disconnected();
    clearTimeout(timer);
    timer = undefined;
    untracked(() => late.set(false));
    if (waiting) timer = setTimeout(() => late.set(true), LOAD_PATIENCE_MS);
  });
  // A retry is over when it landed or failed again.
  let settle: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (here()) retrying.set(false);
  });
  cleanup(() => {
    clearTimeout(timer);
    clearTimeout(settle);
  });

  return {
    status,
    shown: () => {
      const now = status();
      return now === "ready" ? "empty" : now;
    },
    failure,
    retrying,
    retry() {
      retrying.set(true);
      late.set(false);
      clearTimeout(timer);
      clearTimeout(settle);
      timer = setTimeout(() => late.set(true), LOAD_PATIENCE_MS);
      settle = setTimeout(() => retrying.set(false), LOAD_PATIENCE_MS);
      if (host.paused() || failure() === "missing") host.retry();
      else host.wake();
    },
    why: () => loadFailureText(failure()),
  };
}

/** Why a region did not load, in the user's words, and that nothing of theirs is lost. */
function loadFailureText(failure: LoadFailure | undefined): string {
  switch (failure) {
    case "offline":
      return uiText("loadFailedOffline");
    case "unsupported":
      return uiText("loadFailedUnsupported");
    case "missing":
      return uiText("loadFailedMissing");
    default:
      return uiText("loadFailedSlow");
  }
}
