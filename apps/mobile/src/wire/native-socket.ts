import type { RefusedBy, WireSocket } from "./wire";
import { connect } from "websocket";

/** The runtime refuses credential headers on a handshake, so the token travels in its own. */
const TOKEN_HEADER = "X-Eta-Token";

function refusedBy(error: unknown): RefusedBy {
  const { code, status } = error as { code?: string; status?: number };
  if (status === 401 || status === 403) return "token";
  if (code === "ETIMEDOUT") return "timeout";
  return "network";
}

/** `wss://host/ws` for a name, `ws://` for a loopback or explicit `http://` address. */
function wsUrl(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed))
    return `${trimmed.replace(/^http/, "ws")}/ws`;
  if (/^wss?:\/\//.test(trimmed)) return `${trimmed}/ws`;
  return `ws://${trimmed}/ws`;
}

/** The address over HTTP, for the few things outside the wire (`/version`). */
export function httpUrl(address: string, path: string): string {
  return `${wsUrl(address).replace(/^ws/, "http").replace(/\/ws$/, "")}${path}`;
}

export function nativeSocket(address: string, token: string): WireSocket {
  let message: (text: string) => void = () => undefined;
  let close: (refused?: RefusedBy) => void = () => undefined;
  let socket: Awaited<ReturnType<typeof connect>> | undefined;
  let done = false;
  const finish = (refused?: RefusedBy) => {
    if (done) return;
    done = true;
    close(refused);
  };
  const headers: Record<string, string> =
    token === "" ? {} : { [TOKEN_HEADER]: token };
  connect(wsUrl(address), { headers }).then(
    async (opened) => {
      socket = opened;
      if (done) {
        void opened.close();
        return;
      }
      try {
        for (;;) {
          const frame = await opened.read();
          if (frame === null) break;
          if (typeof frame === "string") message(frame);
        }
        finish();
      } catch {
        finish();
      }
    },
    (error: unknown) => finish(refusedBy(error)),
  );
  return {
    send: (text) => {
      void socket?.write(text);
    },
    close: () => {
      finish();
      void socket?.close();
    },
    onMessage: (listener) => {
      message = listener;
    },
    onClose: (listener) => {
      close = listener;
    },
  };
}
