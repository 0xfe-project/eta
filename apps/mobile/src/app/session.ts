// Which host the phone is connected to, and how that is going. One host at a time: the phone is
// only a screen, and connecting once reaches every machine behind it.

import type { RefusedBy, WireSocket } from "../wire/wire";
import { effect, signal, Storage, untracked } from "nsh";
import { nativeSocket } from "../wire/native-socket";
import { Wire } from "../wire/wire";

const STORAGE_KEY = "eta.host";
/** The lists every screen joins against, for as long as the connection lives. */
const EAGER_TARGETS = [
  "agents",
  "machines",
  "projects",
  "conversations",
  "inbox",
  "tasks",
];
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
export type Phase =
  | "boot"
  | "form"
  | "connecting"
  | "failed"
  | "ready"
  | "disconnected";

export const phase = signal<Phase>("boot");
export const failure = signal<RefusedBy | undefined>(undefined);
export const host = signal<HostAddress | undefined>(undefined);
/** When the host last answered, for “last online”. */
export const lastOnlineAt = signal<number | undefined>(undefined);

const currentWire = signal<Wire | undefined>(undefined);

/** Replaced by DevApp and tests: the fake host instead of the network. */
let openSocket: (target: HostAddress) => WireSocket = (target) =>
  nativeSocket(target.address, target.token);

export function useSocketFactory(
  open: (target: HostAddress) => WireSocket,
): void {
  openSocket = open;
}

/** The wire. Only screens behind `ready` call it. Reactive. */
export function wire(): Wire {
  const current = currentWire();
  if (current === undefined) throw new Error("no connection");
  return current;
}

/** The give-up clock of the wire in use. */
let giveUp: ReturnType<typeof setTimeout> | undefined;

function stopGiveUp(): void {
  clearTimeout(giveUp);
  giveUp = undefined;
}

function startGiveUp(): void {
  if (giveUp !== undefined) return;
  giveUp = setTimeout(() => {
    giveUp = undefined;
    phase.set("disconnected");
  }, GIVE_UP_MS);
}

function watch(next: Wire): void {
  effect(() => {
    const status = next.status();
    const seen = next.lastSeenAt();
    if (seen !== undefined) lastOnlineAt.set(seen);
    if (untracked(() => currentWire()) !== next) return;
    const now = untracked(() => phase());
    if (status === "open") {
      stopGiveUp();
      if (now !== "ready") {
        phase.set("ready");
        const target = untracked(() => host());
        if (target !== undefined)
          void Storage.setItem(STORAGE_KEY, JSON.stringify(target));
      }
      return;
    }
    if (status !== "reconnecting") return;
    const refused = next.refused();
    // A wrong token will not fix itself, whether it was just typed or the host changed it since.
    if (now === "connecting" || refused === "token") {
      stopGiveUp();
      failure.set(refused ?? "network");
      phase.set("failed");
      next.close();
      return;
    }
    if (now === "ready") startGiveUp();
  });
}

function start(target: HostAddress): void {
  stopGiveUp();
  untracked(() => currentWire())?.close();
  host.set(target);
  const next = new Wire({ open: () => openSocket(target) });
  // `hello` carries these once; only a subscription keeps them current.
  for (const name of EAGER_TARGETS) next.subscribe(name);
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
  stopGiveUp();
  phase.set("ready");
  current.retryNow();
  // Still down after this try: back to 08b′ after the same wait.
  if (untracked(() => current.status()) !== "open") startGiveUp();
}

/** Forget the host and go back to the form (Settings → Connection → Disconnect, switch to another host machine). */
export function disconnect(): void {
  stopGiveUp();
  failure.set(undefined);
  // The form first: the screens read the wire until they are gone.
  phase.set("form");
  untracked(() => currentWire())?.close();
  currentWire.set(undefined);
  void Storage.removeItem(STORAGE_KEY);
}
