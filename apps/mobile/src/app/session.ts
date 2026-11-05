// Which host the phone is connected to, and how that is going. One host at a time: the phone is
// only a screen, and connecting once reaches every machine behind it.

import type { RefusedBy, WireSocket } from "../wire/wire";
import { effect, signal, Storage, untracked } from "nsh";
import { nativeSocket } from "../wire/native-socket";
import { Wire } from "../wire/wire";

const STORAGE_KEY = "eta.host";
/** How long a dropped connection may keep retrying before the app says so with a whole screen. */
const GIVE_UP_MS = 30_000;

export interface HostAddress {
  address: string;
  token: string;
}

/**
 * - `boot`: reading the stored host.
 * - `form`: nothing to connect to yet (08).
 * - `connecting`: first attempt at the host in the form.
 * - `failed`: the host in the form refused or was not there (08a); `failure` says why.
 * - `ready`: the app shows; while the wire is `reconnecting` it shows the banner (08b).
 * - `disconnected`: retried for a while and gave up (08b′).
 */
export type Phase = "boot" | "form" | "connecting" | "failed" | "ready" | "disconnected";

export const phase = signal<Phase>("boot");
export const failure = signal<RefusedBy | undefined>(undefined);
export const host = signal<HostAddress | undefined>(undefined);
/** When the host last answered, for 「上次在线」. */
export const lastOnlineAt = signal<number | undefined>(undefined);

const currentWire = signal<Wire | undefined>(undefined);

/** Replaced by DevApp and tests: the fake host instead of the network. */
let openSocket: (target: HostAddress) => WireSocket = (target) =>
  nativeSocket(target.address, target.token);

export function useSocketFactory(open: (target: HostAddress) => WireSocket): void {
  openSocket = open;
}

/** The wire. Only screens behind `ready` call it. Reactive. */
export function wire(): Wire {
  const current = currentWire();
  if (current === undefined) throw new Error("no connection");
  return current;
}

function watch(next: Wire): void {
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const status = next.status();
    const seen = next.lastSeenAt();
    if (seen !== undefined) lastOnlineAt.set(seen);
    if (untracked(() => currentWire()) !== next) return;
    const now = untracked(() => phase());
    if (status === "open") {
      clearTimeout(giveUp);
      giveUp = undefined;
      if (now !== "ready") {
        phase.set("ready");
        const target = untracked(() => host());
        if (target !== undefined) void Storage.setItem(STORAGE_KEY, JSON.stringify(target));
      }
      return;
    }
    if (status !== "reconnecting") return;
    if (now === "connecting") {
      // The first attempt failed: say so at once, a wrong token will not fix itself.
      failure.set(next.refused() ?? "network");
      phase.set("failed");
      next.close();
      return;
    }
    if (now === "ready" && giveUp === undefined) {
      giveUp = setTimeout(() => {
        giveUp = undefined;
        phase.set("disconnected");
      }, GIVE_UP_MS);
    }
  });
}

function start(target: HostAddress): void {
  untracked(() => currentWire())?.close();
  host.set(target);
  const next = new Wire({ open: () => openSocket(target) });
  currentWire.set(next);
  watch(next);
  next.connect();
}

/** Read the stored host, and connect if there is one. */
export async function boot(): Promise<void> {
  const stored = await Storage.getItem(STORAGE_KEY);
  if (stored === null || stored === undefined) {
    phase.set("form");
    return;
  }
  try {
    const target = JSON.parse(stored) as HostAddress;
    start(target);
    phase.set("ready");
  } catch {
    phase.set("form");
  }
}

/** Connect to the host in the form. */
export function connectTo(target: HostAddress): void {
  failure.set(undefined);
  phase.set("connecting");
  start(target);
}

/** Retry from 08b′ or the banner, keeping what is on screen. */
export function retry(): void {
  const current = untracked(() => currentWire());
  if (current === undefined) return;
  phase.set("ready");
  current.retryNow();
}

/** Forget the host and go back to the form (设置 → 连接 → 断开连接, 换一台主机). */
export function disconnect(): void {
  untracked(() => currentWire())?.close();
  currentWire.set(undefined);
  void Storage.removeItem(STORAGE_KEY);
  failure.set(undefined);
  phase.set("form");
}

