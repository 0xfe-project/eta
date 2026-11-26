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
import { Buffer } from "node:buffer";
import { LINK_CLOSE, LINK_LIMITS } from "@eta/client-contracts";

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
const isHighSurrogate = (code: number): boolean =>
  code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean =>
  code >= 0xdc00 && code <= 0xdfff;

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
  chunkBytes?: number | undefined;
  maxMessageBytes?: number | undefined;
  maxInFlightChunks?: number | undefined;
  chunked?: boolean | undefined;
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

interface Reassembling {
  total: number;
  parts: string[];
  bytes: number;
}

export class Peer {
  readonly #send: (text: string) => void;
  readonly #closeSocket: PeerOptions["close"];
  readonly #onPipe: PeerOptions["onPipe"];
  readonly #onCtl: PeerOptions["onCtl"];
  readonly #warn: (message: string) => void;
  readonly #maxFrame: number;
  readonly #chunkBytes: number;
  readonly #maxMessage: number;
  readonly #maxInFlightChunks: number;
  readonly #maxInFlight: number;
  readonly #defaultTimeout: number;
  readonly #handlers = new Map<string, ServeHandler>();
  readonly #notified = new Map<string, (params: unknown) => void>();
  readonly #outgoing = new Map<string, Outgoing>();
  readonly #serving = new Map<string, AbortController>();
  readonly #reassembling = new Map<string, Reassembling>();
  #outboundMaxMessage: number;
  #chunking: boolean;
  #next = 0;
  #nextChunk = 0;
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
    this.#chunkBytes = options.chunkBytes ?? LINK_LIMITS.chunkBytes;
    this.#maxMessage = Math.max(
      this.#maxFrame,
      options.maxMessageBytes ?? LINK_LIMITS.maxMessageBytes,
    );
    this.#outboundMaxMessage = this.#maxMessage;
    this.#maxInFlightChunks =
      options.maxInFlightChunks ?? LINK_LIMITS.maxInFlightChunks;
    this.#chunking = options.chunked === true;
    this.#maxInFlight = options.maxInFlight ?? LINK_LIMITS.maxInFlight;
    this.#defaultTimeout =
      options.defaultTimeoutMs ?? LINK_LIMITS.callTimeoutMs;
  }

  get lost(): boolean {
    return this.#lost;
  }

  get chunked(): boolean {
    return this.#chunking;
  }

  get reassemblingCount(): number {
    return this.#reassembling.size;
  }

  /** Enable outbound chunking once the remote peer advertises chunk support. */
  enableChunking(options?: { maxMessageBytes?: number | undefined }): void {
    this.#chunking = true;
    const remoteMax = options?.maxMessageBytes;
    if (
      typeof remoteMax === "number" &&
      Number.isFinite(remoteMax) &&
      remoteMax > 0
    ) {
      this.#outboundMaxMessage = Math.max(
        this.#maxFrame,
        Math.min(this.#maxMessage, Math.floor(remoteMax)),
      );
    }
  }

  /* ------------------------------------------------------------ sending */

  #emit(envelope: LinkEnvelope): void {
    if (this.#lost) return;
    const text = JSON.stringify(envelope);
    const bytes = byteLength(text);
    if (bytes <= this.#maxFrame) {
      this.#send(text);
      return;
    }
    if (!this.#chunking || envelope.ch === "ctl" || envelope.ch === "chunk") {
      throw new LinkError(
        "remote",
        `that is too big to send over the link (${bytes} bytes, the limit is ${this.#maxFrame})`,
      );
    }
    if (bytes > this.#outboundMaxMessage) {
      throw new LinkError(
        "remote",
        `that is too big to send over the link (${bytes} bytes, the limit is ${this.#outboundMaxMessage})`,
      );
    }
    const id = `c${++this.#nextChunk}`;
    const pieces = this.#splitChunks(text, id);
    const total = pieces.length;
    for (let index = 0; index < total; index += 1) {
      if (this.#lost) return;
      this.#send(
        JSON.stringify({
          ch: "chunk",
          id,
          index,
          total,
          data: pieces[index]!,
        } satisfies LinkEnvelope),
      );
    }
  }

  #splitChunks(text: string, id: string): string[] {
    const maxIndex = Math.max(999_999, text.length);
    const reserve = byteLength(
      JSON.stringify({
        ch: "chunk",
        id,
        index: maxIndex,
        total: maxIndex,
        data: "",
      }),
    );
    const maxDataBytes = this.#maxFrame - reserve;
    const budget = Math.min(this.#chunkBytes, maxDataBytes);
    if (budget <= 0) {
      throw new LinkError(
        "remote",
        `that is too big to send over the link (maxFrameBytes ${this.#maxFrame} cannot carry a chunk envelope)`,
      );
    }
    const pieces: string[] = [];
    let offset = 0;
    while (offset < text.length) {
      let take = Math.min(budget, text.length - offset);
      if (
        take > 1 &&
        offset + take < text.length &&
        isHighSurrogate(text.charCodeAt(offset + take - 1)) &&
        isLowSurrogate(text.charCodeAt(offset + take))
      ) {
        take -= 1;
      }
      let slice = text.slice(offset, offset + take);
      let actual = byteLength(JSON.stringify(slice)) - 2;
      while (actual > maxDataBytes) {
        if (take <= 1) {
          throw new LinkError(
            "remote",
            `that is too big to send over the link (cannot fit chunk within ${this.#maxFrame} bytes)`,
          );
        }
        take = Math.max(
          1,
          Math.min(take - 1, Math.floor((take * maxDataBytes) / actual)),
        );
        if (
          take > 1 &&
          offset + take < text.length &&
          isHighSurrogate(text.charCodeAt(offset + take - 1)) &&
          isLowSurrogate(text.charCodeAt(offset + take))
        ) {
          take -= 1;
        }
        slice = text.slice(offset, offset + take);
        actual = byteLength(JSON.stringify(slice)) - 2;
      }
      pieces.push(slice);
      offset += take;
    }
    return pieces;
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
    const bytes = byteLength(text);
    if (bytes > this.#maxFrame) {
      this.#reassembling.clear();
      this.#warn(`[link] a frame of ${bytes} bytes is over the limit`);
      this.#closeSocket(LINK_CLOSE.tooBig, "frame too big");
      return;
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      this.#reassembling.clear();
      this.#closeSocket(LINK_CLOSE.protocol, "not json");
      return;
    }
    this.#dispatch(envelope, true);
  }

  #dispatch(raw: unknown, allowChunk: boolean): void {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      this.#reassembling.clear();
      this.#closeSocket(LINK_CLOSE.protocol, "invalid envelope");
      return;
    }
    const envelope = raw as LinkEnvelope;
    switch (envelope.ch) {
      case "pipe":
        this.#onPipe(envelope.frame);
        return;
      case "ctl": {
        const message = envelope.msg;
        if (typeof message !== "object" || message === null) {
          this.#reassembling.clear();
          this.#closeSocket(LINK_CLOSE.protocol, "invalid ctl");
          return;
        }
        if (message.op === "ping") this.sendCtl({ op: "pong" });
        else if (message.op !== "pong") this.#onCtl?.(message);
        return;
      }
      case "svc":
        if (typeof envelope.msg !== "object" || envelope.msg === null) {
          this.#reassembling.clear();
          this.#closeSocket(LINK_CLOSE.protocol, "invalid svc");
          return;
        }
        this.#svc(envelope.msg);
        return;
      case "chunk":
        if (!allowChunk) {
          this.#reassembling.clear();
          this.#closeSocket(LINK_CLOSE.protocol, "nested chunk");
          return;
        }
        this.#receiveChunk(envelope);
        return;
      default:
        this.#reassembling.clear();
        this.#closeSocket(LINK_CLOSE.protocol, "unknown channel");
    }
  }

  #receiveChunk(chunk: Extract<LinkEnvelope, { ch: "chunk" }>): void {
    const { id, index, total, data } = chunk as Partial<
      Extract<LinkEnvelope, { ch: "chunk" }>
    >;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > 128 ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      typeof total !== "number" ||
      !Number.isInteger(total) ||
      total < 1 ||
      index >= total ||
      typeof data !== "string" ||
      (total > 1 && data.length === 0)
    ) {
      this.#reassembling.clear();
      this.#closeSocket(LINK_CLOSE.protocol, "invalid chunk");
      return;
    }
    let pending = this.#reassembling.get(id);
    if (pending === undefined) {
      if (index !== 0) {
        this.#reassembling.clear();
        this.#closeSocket(LINK_CLOSE.protocol, "invalid chunk index");
        return;
      }
      if (this.#reassembling.size >= this.#maxInFlightChunks) {
        this.#reassembling.clear();
        this.#closeSocket(
          LINK_CLOSE.protocol,
          "too many concurrent chunked messages",
        );
        return;
      }
      pending = { total, parts: [], bytes: 0 };
      this.#reassembling.set(id, pending);
    } else if (pending.total !== total || index !== pending.parts.length) {
      this.#reassembling.clear();
      this.#closeSocket(LINK_CLOSE.protocol, "invalid chunk sequence");
      return;
    }
    pending.bytes += byteLength(data);
    if (pending.bytes > this.#maxMessage) {
      this.#reassembling.clear();
      this.#warn(
        `[link] a chunked message of ${pending.bytes} bytes is over the limit`,
      );
      this.#closeSocket(LINK_CLOSE.tooBig, "message too big");
      return;
    }
    pending.parts.push(data);
    if (pending.parts.length < pending.total) return;
    this.#reassembling.delete(id);
    const full = pending.parts.join("");
    if (byteLength(full) > this.#maxMessage) {
      this.#reassembling.clear();
      this.#warn(
        `[link] a chunked message of ${byteLength(full)} bytes is over the limit`,
      );
      this.#closeSocket(LINK_CLOSE.tooBig, "message too big");
      return;
    }
    let inner: unknown;
    try {
      inner = JSON.parse(full);
    } catch {
      this.#reassembling.clear();
      this.#closeSocket(LINK_CLOSE.protocol, "chunked payload is not json");
      return;
    }
    this.#dispatch(inner, false);
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
    this.#reassembling.clear();
  }
}
