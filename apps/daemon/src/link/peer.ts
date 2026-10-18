/**
 * One end of the link, with no socket library involved.
 *
 * A `Peer` is handed a way to send text and is fed the text that arrives. It speaks the envelope
 * (`@eta/client-contracts` `link.ts`) and keeps the rules that make the link safe to lean on:
 *
 * - **Bounded.** A frame over the limit breaks the link; more calls in flight than the limit are
 *   refused with a reason, not queued; every call has a deadline; silence past the limit is death.
 * - **Nothing is replayed.** The moment the link is lost every call this end was waiting on fails
 *   with an error that says the outcome is unknown, and every handler the other end had running
 *   here is told to stop. A new link starts empty.
 * - **One shape for both directions.** Either end may call, stream, cancel and notify; which end
 *   answers which methods is a matter of which handlers it registered.
 */
import type {
  CtlMessage,
  LinkEnvelope,
  SvcMessage,
} from "@eta/client-contracts";
import { LINK_CLOSE, LINK_LIMITS } from "@eta/client-contracts";

/** Why a call did not return a result. */
export class LinkError extends Error {
  readonly kind: "lost" | "timeout" | "remote" | "busy" | "aborted";
  constructor(kind: LinkError["kind"], message: string) {
    super(message);
    this.name = "LinkError";
    this.kind = kind;
  }
}

/** What a handler is given about the call it is serving. */
export interface ServeContext {
  /** Fires when the caller cancels, or the link is lost. */
  signal: AbortSignal;
  /** Send an event back to the caller, who is streaming. */
  emit: (event: unknown) => void;
}

export type ServeHandler = (
  params: unknown,
  context: ServeContext,
) => unknown | Promise<unknown>;

export interface PeerOptions {
  send: (text: string) => void;
  /** Close the socket. Used when the other end breaks a rule. */
  close: (code: number, reason: string) => void;
  /** A frame of the pipe channel arrived. */
  onPipe: (frame: unknown) => void;
  /** A control message arrived (the peer has already answered pings). */
  onCtl?: ((message: CtlMessage) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
  maxFrameBytes?: number | undefined;
  maxInFlight?: number | undefined;
  defaultTimeoutMs?: number | undefined;
}

interface Outgoing {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent: ((event: unknown) => void) | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  cleanup: () => void;
}

export interface CallOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Events the other end streams while it works. */
  onEvent?: ((event: unknown) => void) | undefined;
}

export class Peer {
  readonly #send: (text: string) => void;
  readonly #closeSocket: PeerOptions["close"];
  readonly #onPipe: PeerOptions["onPipe"];
  readonly #onCtl: PeerOptions["onCtl"];
  readonly #warn: (message: string) => void;
  readonly #maxFrame: number;
  readonly #maxInFlight: number;
  readonly #defaultTimeout: number;
  readonly #handlers = new Map<string, ServeHandler>();
  readonly #notified = new Map<string, (params: unknown) => void>();
  readonly #outgoing = new Map<string, Outgoing>();
  readonly #serving = new Map<string, AbortController>();
  #next = 0;
  #lost = false;
  #lastHeard = Date.now();
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(options: PeerOptions) {
    this.#send = options.send;
    this.#closeSocket = options.close;
    this.#onPipe = options.onPipe;
    this.#onCtl = options.onCtl;
    this.#warn = options.warn ?? (() => undefined);
    this.#maxFrame = options.maxFrameBytes ?? LINK_LIMITS.maxFrameBytes;
    this.#maxInFlight = options.maxInFlight ?? LINK_LIMITS.maxInFlight;
    this.#defaultTimeout =
      options.defaultTimeoutMs ?? LINK_LIMITS.callTimeoutMs;
  }

  get lost(): boolean {
    return this.#lost;
  }

  /* ------------------------------------------------------------ sending */

  #emit(envelope: LinkEnvelope): void {
    if (this.#lost) return;
    const text = JSON.stringify(envelope);
    if (text.length > this.#maxFrame) {
      throw new LinkError(
        "remote",
        `that is too big to send over the link (${text.length} bytes, the limit is ${this.#maxFrame})`,
      );
    }
    this.#send(text);
  }

  /** A frame of the pipe protocol. */
  sendPipe(frame: unknown): void {
    this.#emit({ ch: "pipe", frame });
  }

  sendCtl(message: CtlMessage): void {
    this.#emit({ ch: "ctl", msg: message });
  }

  /** Tell the other end something and do not wait: it may be ignored, and nothing answers. */
  notify(method: string, params?: unknown): void {
    this.#emit({
      ch: "svc",
      msg: {
        op: "notify",
        method,
        ...(params === undefined ? {} : { params }),
      },
    });
  }

  /**
   * Ask the other end to do something. The promise settles with its result or with a `LinkError`
   * that says which way it failed: the other end refused (`remote`), took too long (`timeout`),
   * was told to stop (`aborted`), or the link went away under the call (`lost`), in which case
   * nobody knows whether it happened.
   */
  call(
    method: string,
    params: unknown,
    options: CallOptions = {},
  ): Promise<unknown> {
    if (this.#lost) {
      return Promise.reject(
        new LinkError("lost", `${method}: the link is down; nothing was sent`),
      );
    }
    const id = `${++this.#next}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#defaultTimeout;
      const signal = options.signal;
      const settle = (): void => {
        const pending = this.#outgoing.get(id);
        if (pending === undefined) return;
        this.#outgoing.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        pending.cleanup();
      };
      const onAbort = (): void => {
        if (!this.#outgoing.has(id)) return;
        settle();
        // Best effort: if the link is gone there is nobody to tell.
        try {
          this.#emit({ ch: "svc", msg: { op: "cancel", id } });
        } catch {
          // Nothing to cancel on a link that cannot carry the cancel.
        }
        reject(new LinkError("aborted", `${method}: cancelled`));
      };
      const timer = setTimeout(() => {
        if (!this.#outgoing.has(id)) return;
        settle();
        try {
          this.#emit({ ch: "svc", msg: { op: "cancel", id } });
        } catch {
          // As above.
        }
        reject(
          new LinkError(
            "timeout",
            `${method}: no answer within ${timeoutMs} ms; the outcome is unknown`,
          ),
        );
      }, timeoutMs);
      this.#outgoing.set(id, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
        onEvent: options.onEvent,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        this.#emit({
          ch: "svc",
          msg: {
            op: "call",
            id,
            method,
            ...(params === undefined ? {} : { params }),
          },
        });
      } catch (error) {
        settle();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /* ------------------------------------------------------------ serving */

  /** Answer calls to `method`. A handler that throws answers with its message. */
  handle(method: string, handler: ServeHandler): void {
    this.#handlers.set(method, handler);
  }

  onNotify(method: string, handler: (params: unknown) => void): void {
    this.#notified.set(method, handler);
  }

  /* ------------------------------------------------------------ receiving */

  /** Feed one text frame from the socket. */
  receive(text: string): void {
    if (this.#lost) return;
    this.#lastHeard = Date.now();
    if (text.length > this.#maxFrame) {
      this.#warn(`[link] a frame of ${text.length} bytes is over the limit`);
      this.#closeSocket(LINK_CLOSE.tooBig, "frame too big");
      return;
    }
    let envelope: LinkEnvelope;
    try {
      envelope = JSON.parse(text) as LinkEnvelope;
    } catch {
      this.#closeSocket(LINK_CLOSE.protocol, "not json");
      return;
    }
    switch (envelope.ch) {
      case "pipe":
        this.#onPipe(envelope.frame);
        return;
      case "ctl": {
        const message = envelope.msg;
        if (message.op === "ping") this.sendCtl({ op: "pong" });
        else if (message.op !== "pong") this.#onCtl?.(message);
        return;
      }
      case "svc":
        this.#svc(envelope.msg);
        return;
      default:
        this.#closeSocket(LINK_CLOSE.protocol, "unknown channel");
    }
  }

  #svc(message: SvcMessage): void {
    switch (message.op) {
      case "reply": {
        const pending = this.#outgoing.get(message.id);
        if (pending === undefined) return;
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new LinkError("remote", message.error));
        return;
      }
      case "event":
        this.#outgoing.get(message.id)?.onEvent?.(message.event);
        return;
      case "cancel":
        this.#serving.get(message.id)?.abort();
        return;
      case "notify":
        try {
          this.#notified.get(message.method)?.(message.params);
        } catch (error) {
          this.#warn(`[link] ${message.method}: ${String(error)}`);
        }
        return;
      case "call":
        this.#serve(message);
    }
  }

  #serve(call: Extract<SvcMessage, { op: "call" }>): void {
    const fail = (error: string): void => {
      try {
        this.#emit({
          ch: "svc",
          msg: { op: "reply", id: call.id, ok: false, error },
        });
      } catch (sendError) {
        this.#warn(`[link] ${String(sendError)}`);
      }
    };
    const handler = this.#handlers.get(call.method);
    if (handler === undefined) return fail(`unknown method: ${call.method}`);
    if (this.#serving.size >= this.#maxInFlight)
      return fail(
        `busy: ${this.#serving.size} calls are already running (the limit is ${this.#maxInFlight})`,
      );
    const controller = new AbortController();
    this.#serving.set(call.id, controller);
    void (async () => {
      try {
        const result = await handler(call.params, {
          signal: controller.signal,
          emit: (event) => {
            if (controller.signal.aborted) return;
            this.#emit({
              ch: "svc",
              msg: { op: "event", id: call.id, event },
            });
          },
        });
        if (controller.signal.aborted) return;
        this.#emit({
          ch: "svc",
          msg: {
            op: "reply",
            id: call.id,
            ok: true,
            ...(result === undefined ? {} : { result }),
          },
        });
      } catch (error) {
        if (!controller.signal.aborted)
          fail(error instanceof Error ? error.message : String(error));
      } finally {
        this.#serving.delete(call.id);
      }
    })();
  }

  /* ------------------------------------------------------------ liveness */

  /**
   * Keep the link honest. `pingEveryMs` makes this end speak when it has nothing to say (the
   * daemon does; the primary only listens), and silence for `silenceMs` closes the socket.
   */
  watch(options: {
    pingEveryMs?: number | undefined;
    silenceMs?: number | undefined;
  }): void {
    const silence = options.silenceMs ?? LINK_LIMITS.silenceMs;
    if (options.pingEveryMs !== undefined) {
      this.#timers.push(
        setInterval(() => {
          try {
            this.sendCtl({ op: "ping" });
          } catch {
            // A link that cannot carry a ping is about to be reported lost.
          }
        }, options.pingEveryMs),
      );
    }
    this.#timers.push(
      setInterval(
        () => {
          if (Date.now() - this.#lastHeard > silence)
            this.#closeSocket(LINK_CLOSE.silent, "silent");
        },
        Math.max(10, Math.floor(silence / 3)),
      ),
    );
  }

  /**
   * The socket is gone. Every call this end was waiting on fails as an unknown outcome, every
   * handler it was running is told to stop, and nothing is sent again.
   */
  markLost(reason: string): void {
    if (this.#lost) return;
    this.#lost = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    for (const [id, pending] of [...this.#outgoing.entries()]) {
      this.#outgoing.delete(id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(
        new LinkError(
          "lost",
          `the link was lost (${reason}) while this was running; the outcome is unknown`,
        ),
      );
    }
    for (const controller of this.#serving.values()) controller.abort();
    this.#serving.clear();
  }
}
