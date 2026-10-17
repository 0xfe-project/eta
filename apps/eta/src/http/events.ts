/**
 * The event stream: every event gets a `seq`, a ring keeps the recent ones, and a cursor that is
 * too old gets a clear answer instead of a silent gap (REFACTOR.md §4.1, §9 P0.5).
 *
 * The shape of the contract, which is what the front end depends on:
 *
 *   GET /events?cursor=<seq>      resume after that seq
 *   Last-Event-ID                 an EventSource sends it on reconnect; it wins over `cursor`
 *   id: <seq>                     every frame is numbered, so a reconnect names where it stopped
 *   410 CURSOR_EXPIRED            the cursor is older than the ring; read the snapshot again
 *
 * No cursor means "from now": a client without a snapshot has nothing to catch up on, and
 * replaying the ring at it would hand it events it may already have.
 */
import { errorResponse } from "../routes";

export interface ProductEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface EventHubOptions {
  /** How many events stay replayable for a reconnecting client. */
  capacity?: number;
  /**
   * A comment line this often keeps an idle stream alive.
   *
   * The number is not decoration: the server has an idle timeout, and a stream that says
   * nothing for longer than it is a stream that gets cut — the client then reconnects, replays,
   * and does the whole thing again, forever, for a feed nobody was speaking on. Bun's HTTP idle
   * timeout is 10s, so anything at or above that turns every quiet stream into a reconnect loop.
   */
  heartbeatMs?: number;
}

/**
 * How another surface names an event. Returning `undefined` means "this surface has no word for
 * it" and no frame is written — the seq is still consumed, so a client resuming from the id of
 * the last frame it *saw* loses nothing.
 */
interface EventTranslation {
  name: string;
  data: unknown;
}

export type EventTranslator = (
  event: ProductEvent,
) => EventTranslation | undefined;

type Cursor =
  | { kind: "none" }
  | { kind: "cursor"; value: number }
  | { kind: "invalid"; raw: string };

/** `Last-Event-ID` if the caller sent one, otherwise `?cursor=`; a bad value is not ignored. */
function parseCursor(request: Request): Cursor {
  const raw =
    request.headers.get("last-event-id") ??
    new URL(request.url).searchParams.get("cursor");
  if (raw === null || raw.length === 0) return { kind: "none" };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return { kind: "invalid", raw };
  return { kind: "cursor", value };
}

export class EventHub {
  readonly #capacity: number;
  readonly #heartbeatMs: number;
  readonly #subscribers = new Set<(event: ProductEvent) => void>();
  #seq = 0;
  #buffer: ProductEvent[] = [];

  constructor(options: EventHubOptions = {}) {
    this.#capacity = options.capacity ?? 512;
    // Under Bun's 10s HTTP idle timeout, with room for a slow write on top of it.
    this.#heartbeatMs = options.heartbeatMs ?? 5_000;
  }

  /** Publish one event. The seq it returns is what a client resumes from. */
  publish(type: string, data: unknown): ProductEvent {
    const event: ProductEvent = { seq: (this.#seq += 1), type, data };
    this.#buffer.push(event);
    if (this.#buffer.length > this.#capacity) {
      this.#buffer.splice(0, this.#buffer.length - this.#capacity);
    }
    for (const subscriber of this.#subscribers) subscriber(event);
    return event;
  }

  /** The ring, for the host and for tests. */
  events(): readonly ProductEvent[] {
    return this.#buffer;
  }

  /** The last seq handed out: what a snapshot reports as its cursor. */
  get sequence(): number {
    return this.#seq;
  }

  /** How many clients are following right now. */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** Whether a client at `cursor` can be served every event it has not seen. */
  canReplay(cursor: number): boolean {
    const oldest = this.#buffer[0]?.seq;
    // Nothing is buffered, so nothing can have been missed; otherwise the cursor has to be
    // at or just behind the oldest event we still hold.
    return oldest === undefined || cursor >= oldest - 1;
  }

  /**
   * The SSE response for a stream of these events.
   *
   * `translate` lets a surface with its own vocabulary (the product API, P2.4) rename and reshape
   * events on the way out, instead of a second copy of the cursor, replay and heartbeat rules
   * living here.
   */
  handle(
    request: Request,
    options: { translate?: EventTranslator | undefined } = {},
  ): Response {
    const cursor = parseCursor(request);
    if (cursor.kind === "invalid") {
      return errorResponse(
        400,
        "INVALID_CURSOR",
        `not a cursor: ${cursor.raw}`,
        crypto.randomUUID(),
      );
    }
    if (cursor.kind === "cursor" && !this.canReplay(cursor.value)) {
      return errorResponse(
        410,
        "CURSOR_EXPIRED",
        "this cursor is older than the events kept; read the snapshot again",
        crypto.randomUUID(),
      );
    }

    const encoder = new TextEncoder();
    const frame = (event: ProductEvent): string | undefined => {
      const translated =
        options.translate === undefined
          ? { name: event.type, data: event.data }
          : options.translate(event);
      if (translated === undefined) return undefined;
      return `id: ${event.seq}\nevent: ${translated.name}\ndata: ${JSON.stringify(translated.data)}\n\n`;
    };

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let subscriber: ((event: ProductEvent) => void) | undefined;

    const stop = (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): void => {
      if (subscriber !== undefined) this.#subscribers.delete(subscriber);
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      try {
        controller.close();
      } catch {
        // Already closed by the client going away; nothing to do.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (text: string): void => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // The stream is gone; `stop` has already cleaned up.
          }
        };

        // Catch the client up: only what it has not seen.
        if (cursor.kind === "cursor") {
          for (const event of this.#buffer) {
            if (event.seq <= cursor.value) continue;
            const text = frame(event);
            if (text !== undefined) write(text);
          }
        }

        subscriber = (event) => {
          const text = frame(event);
          if (text !== undefined) write(text);
        };
        this.#subscribers.add(subscriber);
        // A comment every so often: no event, no seq, just something on the wire.
        heartbeat = setInterval(write, this.#heartbeatMs, ": keep-alive\n\n");
        request.signal.addEventListener("abort", () => stop(controller), {
          once: true,
        });
      },
      cancel: () => {
        if (subscriber !== undefined) this.#subscribers.delete(subscriber);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        heartbeat = undefined;
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      },
    });
  }
}
