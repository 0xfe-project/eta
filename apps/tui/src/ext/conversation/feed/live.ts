// The session half of apps/web/src/queries/sessions.ts: open a member's session, subscribe to it,
// and keep what its events say about the run in flight.
import type { AgentMessage } from "@eta/client-contracts";
import type { WireClient, WireEvent } from "../../../connection/types";
import type { SessionLive } from "../model/items";

/** A token is an event; the stream is drawn a few times a second, not per token. */
const STREAM_FRAME_MS = 40;
/** How often what a running tool printed is drawn again. */
const TOOL_FRAME_MS = 100;

export const sessionTarget = (sessionId: string) => `sessions.${sessionId}`;

/** A session watched but not heard from yet. */
export function emptyLive(): SessionLive {
  return {
    rows: undefined,
    coreStreaming: undefined,
    streamed: undefined,
    progress: new Map(),
    question: undefined,
    unreadable: false,
  };
}

/** Per wire, per session: the `resync` asked and not failed, settling to whether it succeeded. */
const resyncs = new WeakMap<WireClient, Map<string, Promise<boolean>>>();

/**
 * A session is only a target once it is open; `resync` opens it. Asked once per wire and session
 * while it succeeds, however many times the session is watched; after a failure the next call
 * asks again. The answer never rejects.
 */
export function resyncOnce(
  wire: WireClient,
  sessionId: string,
): Promise<boolean> {
  let asked = resyncs.get(wire);
  if (asked === undefined) {
    asked = new Map();
    resyncs.set(wire, asked);
  }
  let found = asked.get(sessionId);
  if (found === undefined) {
    const byWire = asked;
    found = wire.call("sessions", "resync", { session: sessionId }).then(
      () => true,
      () => {
        byWire.delete(sessionId);
        return false;
      },
    );
    asked.set(sessionId, found);
  }
  return found;
}

type Change = (live: SessionLive) => SessionLive;

interface ToolUpdate {
  toolCallId?: unknown;
  partialResult?: { content?: { type?: string; text?: string }[] };
}

/**
 * Opens a session, subscribes to it once `resync` has answered (whatever it answered), and turns
 * its events into changes to its `SessionLive`: the streamed message (`streamed`, at most every
 * 40 ms, dropped at once when a turn starts), what running tools printed (`progress`, at most
 * every 100 ms) and `unreadable`, set by whether the resync succeeded. The state sections
 * themselves are not read here. Returns the release, which drops the subscription, the listener
 * and any change not yet made.
 */
export function watchSession(
  wire: WireClient,
  sessionId: string,
  change: (update: Change) => void,
): () => void {
  const target = sessionTarget(sessionId);
  let released = false;
  let unsubscribe: (() => void) | undefined;
  void resyncOnce(wire, sessionId).then((opened) => {
    if (released) return;
    change((live) =>
      live.unreadable === !opened ? live : { ...live, unreadable: !opened },
    );
    unsubscribe = wire.subscribe(target);
  });

  let latest: AgentMessage | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  const outputs = new Map<string, string>();
  let toolTimer: ReturnType<typeof setTimeout> | undefined;

  const streamChanged = () => {
    streamTimer ??= setTimeout(() => {
      streamTimer = undefined;
      const message = latest;
      change((live) => ({ ...live, streamed: message }));
    }, STREAM_FRAME_MS);
  };
  const toolsChanged = () => {
    toolTimer ??= setTimeout(() => {
      toolTimer = undefined;
      const progress = new Map(outputs);
      change((live) => ({ ...live, progress }));
    }, TOOL_FRAME_MS);
  };

  const hear = (event: WireEvent) => {
    switch (event.name) {
      case "message:update":
        latest = (event.data as { message?: AgentMessage } | undefined)
          ?.message;
        streamChanged();
        return;
      case "turn:run-start":
        latest = undefined;
        clearTimeout(streamTimer);
        streamTimer = undefined;
        change((live) =>
          live.streamed === undefined ? live : { ...live, streamed: undefined },
        );
        return;
      case "generation:interrupted":
        latest = undefined;
        streamChanged();
        return;
      case "turn:run-end":
        latest = undefined;
        streamChanged();
        outputs.clear();
        toolsChanged();
        return;
      case "tool:update":
        if (recordToolUpdate(outputs, event.data as ToolUpdate | undefined))
          toolsChanged();
        return;
      case "tool:end": {
        const id = (event.data as ToolUpdate | undefined)?.toolCallId;
        if (typeof id === "string" && outputs.delete(id)) toolsChanged();
      }
    }
  };
  const stopListening = wire.onEvent(target, hear);

  return () => {
    released = true;
    unsubscribe?.();
    stopListening();
    clearTimeout(streamTimer);
    clearTimeout(toolTimer);
  };
}

/** Keeps the text a `tool:update` carried; one that carried no text changes nothing. */
function recordToolUpdate(
  outputs: Map<string, string>,
  data: ToolUpdate | undefined,
): boolean {
  if (typeof data?.toolCallId !== "string") return false;
  const text = (data.partialResult?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (text === "") return false;
  outputs.set(data.toolCallId, text);
  return true;
}
