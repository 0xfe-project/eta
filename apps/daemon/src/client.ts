/**
 * The daemon's side of the connection: dial the primary, prove who it is, and hand the link to
 * whatever serves it, again and again.
 *
 * Only outbound. The credential travels in the handshake's `Authorization` header, never in the
 * address. Each connection starts at `welcome` (the primary says which connection this is and
 * whether the machine has been approved); a machine that is not approved yet is held at the door
 * until the user approves it. When the connection ends for any reason a new one is tried after a
 * wait that grows to a ceiling and starts over after a connection that got in. Nothing is
 * replayed: what was in flight on the old connection is the primary's to fail.
 */
import type { CtlMessage } from "@eta/client-contracts";
import type { Identity } from "./identity";
import { LINK_CLOSE, LINK_LIMITS, LINK_PATH } from "@eta/client-contracts";
import { Peer } from "./link/peer";

/** What serves a link once the machine is let in. */
export interface LinkServer {
  /** Take a link; `receive` gets the pipe frames, `close` is told the link is gone. */
  attach: (
    peer: Peer,
    epoch: number,
  ) => { receive: (frame: unknown) => void; close: () => void };
}

export type LinkState =
  | { state: "connecting" }
  | { state: "pending"; epoch: number }
  | { state: "online"; epoch: number }
  | { state: "revoked" }
  | { state: "down"; reason: string };

export interface DaemonLinkOptions {
  identity: Identity;
  server: LinkServer | undefined;
  onState?: ((state: LinkState) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
  /** Waits between attempts; a test makes them short. */
  backoff?: { minMs: number; maxMs: number } | undefined;
  heartbeatMs?: number | undefined;
  silenceMs?: number | undefined;
}

function linkUrl(primary: string): string {
  const url = new URL(primary);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = LINK_PATH;
  url.search = "";
  return url.toString();
}

export class DaemonLink {
  readonly #options: DaemonLinkOptions;
  readonly #stop = new AbortController();
  #socket: WebSocket | undefined;
  #running: Promise<void> | undefined;

  constructor(options: DaemonLinkOptions) {
    this.#options = options;
  }

  start(): void {
    this.#running ??= this.#loop();
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    this.#socket?.close(1000, "stopping");
    await this.#running;
  }

  /** Drop the current connection (a test's way of cutting the link). */
  drop(): void {
    this.#socket?.close(4000, "dropped");
  }

  #state(state: LinkState): void {
    this.#options.onState?.(state);
  }

  async #loop(): Promise<void> {
    const min = this.#options.backoff?.minMs ?? 1_000;
    const max = this.#options.backoff?.maxMs ?? 30_000;
    let delay = min;
    while (!this.#stop.signal.aborted) {
      this.#state({ state: "connecting" });
      const ended = await this.#connect();
      if (this.#stop.signal.aborted) return;
      if (ended.revoked) {
        this.#state({ state: "revoked" });
        delay = max;
      } else {
        this.#state({ state: "down", reason: ended.reason });
        delay = ended.admitted ? min : Math.min(delay * 2, max);
      }
      // Jitter, so a primary that restarts is not met by every daemon in the same millisecond.
      await sleep(delay * (0.75 + Math.random() * 0.5), this.#stop.signal);
    }
  }

  /** One connection, start to end. */
  #connect(): Promise<{
    admitted: boolean;
    revoked: boolean;
    reason: string;
  }> {
    const { identity, server } = this.#options;
    const warn = this.#options.warn ?? (() => undefined);
    return new Promise((resolve) => {
      let admitted = false;
      let attached: ReturnType<LinkServer["attach"]> | undefined;
      let peer: Peer | undefined;
      let socket: WebSocket;
      try {
        socket = new WebSocket(linkUrl(identity.url), {
          headers: {
            authorization: `Bearer ${identity.machineId}.${identity.secret}`,
          },
        } as never);
      } catch (error) {
        resolve({ admitted, revoked: false, reason: String(error) });
        return;
      }
      this.#socket = socket;
      const open = (epoch: number): void => {
        admitted = true;
        if (server === undefined || peer === undefined) {
          this.#state({ state: "online", epoch });
          return;
        }
        attached = server.attach(peer, epoch);
        this.#state({ state: "online", epoch });
      };
      let epoch = 0;
      const onCtl = (message: CtlMessage): void => {
        if (message.op === "welcome") {
          epoch = message.epoch;
          admitted = true;
          if (message.status === "approved") open(epoch);
          else this.#state({ state: "pending", epoch });
        } else if (message.op === "approved") {
          open(epoch);
        }
      };
      socket.addEventListener("open", () => {
        peer = new Peer({
          send: (text) => socket.send(text),
          close: (code, reason) => socket.close(code, reason),
          onPipe: (frame) => attached?.receive(frame),
          onCtl,
          warn,
        });
        peer.watch({
          pingEveryMs: this.#options.heartbeatMs ?? LINK_LIMITS.heartbeatMs,
          silenceMs: this.#options.silenceMs ?? LINK_LIMITS.silenceMs,
        });
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") peer?.receive(event.data);
      });
      let ended = false;
      const end = (code: number, reason: string): void => {
        if (ended) return;
        ended = true;
        peer?.markLost(reason || `closed ${code}`);
        attached?.close();
        this.#socket = undefined;
        resolve({
          admitted,
          revoked: code === LINK_CLOSE.revoked,
          reason: reason || `closed ${code}`,
        });
      };
      socket.addEventListener("close", (event) =>
        end(event.code, event.reason),
      );
      socket.addEventListener("error", () => end(1006, "could not connect"));
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
