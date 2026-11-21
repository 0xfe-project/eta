// The page's one connection to the host: the shared wire (@eta/client-contracts/wire) over the
// browser's WebSocket, with its state in a zustand store the components select from.

import type { WebSocketLike, WireState } from "@eta/client-contracts/wire";
import type { StoreApi } from "zustand/vanilla";
import {
  fromWebSocket,
  initialWireState,
  Wire as SharedWire,
  wakeOnPageEvents,
} from "@eta/client-contracts/wire";
import { createStore } from "zustand/vanilla";

export { applyState, WireError } from "@eta/client-contracts/wire";
export type { TargetState, WireState } from "@eta/client-contracts/wire";

/** The part of a browser WebSocket the client uses; tests supply their own. */
export type WireSocket = WebSocketLike;

export interface WireOptions {
  /** `ws://host/ws` or `wss://host/ws`. */
  url: string;
  store?: StoreApi<WireState>;
  createSocket?: (url: string) => WireSocket;
  /** How long a call waits for its reply. */
  callTimeoutMs?: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
}

export class Wire extends SharedWire<StoreApi<WireState>> {
  constructor({
    url,
    store = createStore<WireState>(initialWireState),
    createSocket = (url) => new WebSocket(url) as WireSocket,
    ...timing
  }: WireOptions) {
    super({
      ...timing,
      store,
      open: (events) => fromWebSocket(createSocket(url), events),
    });
  }
}

/** The host's socket: `/ws` on the page's own origin, `wss` under https. */
export function wireUrl(location: Pick<Location, "host" | "protocol">): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

let shared: Wire | undefined;
let stopWaking: (() => void) | undefined;

/**
 * The page's one connection, opened on first use. Coming back to the tab, or the browser going
 * online, retries at once (or checks the connection that looks open).
 */
export function getWire(): Wire {
  if (shared === undefined) {
    shared = new Wire({ url: wireUrl(window.location) });
    shared.connect();
    stopWaking = wakeOnPageEvents(shared, { window, document });
  }
  return shared;
}

/** Replace the page's connection; a test installs a fake, `undefined` forgets it. */
export function setWire(wire: Wire | undefined): void {
  stopWaking?.();
  stopWaking = undefined;
  shared?.close();
  shared = wire;
}
