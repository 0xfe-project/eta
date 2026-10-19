import type {
  ServerFrame,
  StatePatch,
  StateSnapshot,
} from "@eta/client-wire-proto";
/**
 * The primary as the client of a daemon's pipe.
 *
 * A daemon is an eta server: the same frames a browser sends the primary, the primary sends it.
 * This is the client half of that, over the link's `pipe` channel. It does three things: calls
 * (with a deadline, and with a cut link failing them as unknown), subscriptions (the daemon's
 * `state` and `event` frames go to whoever asked), and the hello that says the pipe is ready.
 */
import type { Peer } from "@eta/daemon";
import { LINK_LIMITS } from "@eta/client-contracts";
import { LinkError } from "@eta/daemon";

export interface PipeListener {
  /** The daemon's state for the target: whole, or what changed. */
  state: (frame: { snapshot?: StateSnapshot; patch?: StatePatch }) => void;
  event: (name: string, data: unknown, at: number | undefined) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

export class PipeClient {
  readonly #peer: Peer;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Map<string, PipeListener>();
  readonly #ready: Promise<void>;
  #markReady!: () => void;
  #dead: string | undefined;
  #next = 0;

  constructor(peer: Peer) {
    this.#peer = peer;
    this.#ready = new Promise<void>((resolve) => {
      this.#markReady = resolve;
    });
  }

  /** Resolves when the daemon's `hello` has arrived: it is serving. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** A frame from the daemon. */
  receive(frame: unknown): void {
    const server = frame as ServerFrame;
    switch (server.type) {
      case "hello":
        this.#markReady();
        return;
      case "reply": {
        const pending = this.#pending.get(server.requestId);
        if (pending === undefined) return;
        this.#pending.delete(server.requestId);
        clearTimeout(pending.timer);
        pending.cleanup();
        if (server.ok) pending.resolve(server.result);
        else pending.reject(new LinkError("remote", server.error));
        return;
      }
      case "state": {
        const listener = this.#listeners.get(server.target);
        listener?.state({
          ...(server.snapshot === undefined
            ? {}
            : { snapshot: server.snapshot }),
          ...(server.patch === undefined ? {} : { patch: server.patch }),
        });
        return;
      }
      case "event":
        this.#listeners
          .get(server.target)
          ?.event(server.name, server.data, server.at);
        break;
      default:
    }
  }

  /** Call `target.action` on the daemon. */
  call(
    target: string,
    action: string,
    args: unknown,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.#dead !== undefined) {
      return Promise.reject(
        new LinkError(
          "lost",
          `${target}.${action}: the link is down; nothing was sent`,
        ),
      );
    }
    const requestId = `p${++this.#next}`;
    const timeoutMs = options.timeoutMs ?? LINK_LIMITS.callTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const settle = (): Pending | undefined => {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return undefined;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.cleanup();
        return pending;
      };
      const onAbort = (): void => {
        settle();
        reject(new LinkError("aborted", `${target}.${action}: cancelled`));
      };
      const timer = setTimeout(() => {
        settle();
        reject(
          new LinkError(
            "timeout",
            `${target}.${action}: no answer within ${timeoutMs} ms; the outcome is unknown`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        cleanup: () => options.signal?.removeEventListener("abort", onAbort),
      });
      if (options.signal?.aborted === true) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#peer.sendPipe({
          op: "call",
          target,
          action,
          ...(args === undefined ? {} : { args }),
          requestId,
        });
      } catch (error) {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Ask for a target's state and events; one listener per target. */
  subscribe(target: string, listener: PipeListener): void {
    this.#listeners.set(target, listener);
    this.#peer.sendPipe({ op: "subscribe", target });
  }

  unsubscribe(target: string): void {
    if (this.#listeners.delete(target) && !this.#dead)
      this.#peer.sendPipe({ op: "unsubscribe", target });
  }

  subscribed(target: string): boolean {
    return this.#listeners.has(target);
  }

  /** The link is gone: every call waiting fails as an unknown outcome, and nothing is sent again. */
  lost(reason: string): void {
    if (this.#dead !== undefined) return;
    this.#dead = reason;
    for (const [id, pending] of [...this.#pending]) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(
        new LinkError(
          "lost",
          `the link was lost (${reason}) while this was running; the outcome is unknown`,
        ),
      );
    }
    this.#listeners.clear();
  }
}
