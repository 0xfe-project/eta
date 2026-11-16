// The TUI's one connection to a host: the shared wire (@eta/client-contracts/wire) over Bun's
// WebSocket, which can send the token as a bearer header, with its state in a zustand store.

import type {
  WebSocketLike,
  WireObserver,
  WireState,
} from "@eta/client-contracts/wire";
import type { StoreApi } from "zustand/vanilla";
import {
  fromWebSocket,
  initialWireState,
  Wire as SharedWire,
} from "@eta/client-contracts/wire";
import { createStore } from "zustand/vanilla";

export { WireError } from "@eta/client-contracts/wire";
export type { WireObserver } from "@eta/client-contracts/wire";

/** The part of a WebSocket the client uses; tests supply their own. */
export type WireSocket = WebSocketLike;

export interface WireOptions {
  /** `ws://host/ws` or `wss://host/ws`. */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  createSocket?: (url: string, token: string | undefined) => WireSocket;
  /** How long a call waits for its reply. */
  callTimeoutMs?: number;
  /** The pause before the first retry, doubling up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
  observer?: WireObserver;
}

function bunSocket(url: string, token: string | undefined): WireSocket {
  return token === undefined
    ? new WebSocket(url)
    : new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
}

/** One host's `/ws`, kept open across drops until `close`. Call `connect` once to begin. */
export class Wire extends SharedWire<StoreApi<WireState>> {
  constructor({
    url,
    token,
    createSocket = bunSocket,
    maxRetryMs = 5_000,
    ...rest
  }: WireOptions) {
    super({
      ...rest,
      maxRetryMs,
      store: createStore<WireState>(initialWireState),
      open: (events) => fromWebSocket(createSocket(url, token), events),
    });
  }

  /** Stop for good; a connection that was open no longer reads as open. */
  override close(): void {
    super.close();
    if (this.store.getState().status === "open")
      this.store.setState({ status: "reconnecting" });
  }
}
