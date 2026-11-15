/**
 * One assistant generation, consumed as a stream (port of eta-agent's
 * execution/assistant.ts, narrowed to what the kernel owns).
 *
 * The observer is the seam between "the provider is emitting" and "the kernel
 * decides what to do about it": deltas go to the bus as message:update, the
 * settled message ends the turn. pi-ai's own stream class is what the runner
 * consumes, in tests as in production.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { SettledAssistantMessage } from "../types/entries";

/** Process-local lifecycle observer for one assistant stream. */
export interface AssistantStreamObserver {
  start: (
    message: AssistantMessage,
    event: Extract<AssistantMessageEvent, { type: "start" }>,
  ) => void | Promise<void>;
  update: (
    message: AssistantMessage,
    event: AssistantMessageEvent,
  ) => void | Promise<void>;
  end: (message: SettledAssistantMessage) => void | Promise<void>;
}

function isUpdateEvent(
  event: AssistantMessageEvent,
): event is Exclude<
  AssistantMessageEvent,
  { type: "start" | "done" | "error" }
> {
  return (
    event.type !== "start" && event.type !== "done" && event.type !== "error"
  );
}

/** Returned by an interruptible observer's `update` to stop reading the stream. */
export const STOP_STREAM = Symbol("stop-stream");

/**
 * A stream that ended before it ever started.
 *
 * pi-ai pushes `start` only after the HTTP request succeeded, so any failure at
 * the transport layer (a refused request, a 401, a dead socket) arrives as an
 * `error` event with no `start` before it. That event carries the whole story —
 * the status, the provider's own words — and dropping it is how a 400 about
 * tool calls became the sentence "the stream emitted error before start".
 *
 * So the failure keeps the message it came from, and the text this class
 * throws with is the provider's, not a paraphrase of ours.
 */
export class AssistantStreamError extends Error {
  /** The failed message the provider's `error` event carried. */
  readonly assistant: AssistantMessage;

  constructor(assistant: AssistantMessage) {
    const said = assistant.errorMessage ?? "no reason given";
    super(`Assistant message stream emitted error before start: ${said}`, {
      cause: assistant,
    });
    this.name = "AssistantStreamError";
    this.assistant = assistant;
  }
}

/** An observer that may cut the stream short by returning `STOP_STREAM` from `update`. */
export interface InterruptibleStreamObserver
  extends Omit<AssistantStreamObserver, "update"> {
  update: (
    message: AssistantMessage,
    event: AssistantMessageEvent,
  ) => void | typeof STOP_STREAM | Promise<void | typeof STOP_STREAM>;
}

/**
 * Drain a stream through the observer and return the settled message.
 *
 * The lifecycle is strict on purpose: a working stream opens with `start`, and
 * a terminal event before it means the provider broke its contract — better to
 * fail loudly than to record half a message.
 *
 * The observer can stop the read: the frame that returned `STOP_STREAM` is the
 * last one consumed, `end` is never called, and the result is `undefined`. The
 * stream is abandoned, not awaited — whoever stops it owns aborting the
 * request behind it.
 */
export async function consumeInterruptibleStream(
  stream: AssistantMessageEventStream,
  observer: InterruptibleStreamObserver,
): Promise<SettledAssistantMessage | undefined> {
  let started = false;
  for await (const event of stream) {
    if (event.type === "start") {
      if (started)
        throw new Error(
          "Assistant message stream emitted more than one start event",
        );
      started = true;
      await observer.start({ ...event.partial }, event);
      continue;
    }
    if (isUpdateEvent(event)) {
      if (!started)
        throw new Error(
          `Assistant message stream emitted ${event.type} before start`,
        );
      // The partial the provider hands over is the whole message so far; the
      // observer copies it, so nothing downstream can hold a live reference.
      const verdict = await observer.update({ ...event.partial }, event);
      if (verdict === STOP_STREAM) return undefined;
      continue;
    }
    if (event.type === "error" && !started) {
      // Not a contract break: the provider refused the request before it could
      // open a message, and what it said is the only useful thing there is.
      throw new AssistantStreamError(event.error);
    }
    if (!started)
      throw new Error(
        `Assistant message stream emitted ${event.type} before start`,
      );
  }

  const settled = (await stream.result()) as SettledAssistantMessage;
  await observer.end(settled);
  return settled;
}
