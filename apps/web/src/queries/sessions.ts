import type {
  AgentMessage,
  SessionArgs,
  SessionViewSections,
} from "@eta/client-contracts";
import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { logBlocks, runBlocks } from "@/lib/run";
import { getWire } from "@/lib/wire";
import { useWireMutation } from "@/queries/wire";

// A member's session on the wire: `sessions.<id>` is the upstream session view, which is where the
// things the timeline does not hold live (the streamed text of a reply, the question it is waiting
// on, its numbers). A conversation's member names its session once the member has first been woken.

const sessionTarget = (sessionId: string) => `sessions.${sessionId}`;

/** The sections of a session the UI reads; any of them may be missing from a session. */
export type SessionSections = Partial<
  Pick<
    SessionViewSections,
    | "core"
    | "transcript"
    | "usage"
    | "goal"
    | "model"
    | "tools"
    | "prompt"
    | "ask"
    | "metrics"
    | "tasks"
    | "queue"
  >
>;

/** Sessions this page has asked the host to open: a session is only a target while it is open. */
const opened = new Set<string>();

/**
 * Where the read of a session's view stands. A view that has not arrived is early, not broken:
 * `sessions.<id>` is only a target once someone asks for it, so the first frame of any panel that
 * reads a session is a read in flight. A panel that draws that as an error teaches the reader that
 * the feature is broken when it is only a moment late, and then they stop trusting the panel.
 */
export type SessionViewStatus = "loading" | "ready" | "error";

/**
 * One session's view, kept live, and the state of the read behind it. A session the host has not
 * opened since it started (a member that has not been woken since a restart) is not a target yet,
 * so it is opened first (`resync`, which is cheap for one that is already open) and subscribed to
 * after. The view is undefined until it arrives, and for a member that has no session yet; the
 * status says which of "still coming", "here" and "the host said no" that is.
 */
export function useSessionView(sessionId: string | null | undefined): {
  view: SessionSections | undefined;
  status: SessionViewStatus;
} {
  const wire = getWire();
  // Which session the host refused; keyed by id so switching members cannot inherit the failure
  // of the one before and draw a fresh read as a broken one.
  const [failedFor, setFailedFor] = useState<string>();
  useEffect(() => {
    if (sessionId === null || sessionId === undefined) return undefined;
    let release: (() => void) | undefined;
    let cancelled = false;
    const attach = () => {
      if (!cancelled) release = wire.subscribe(sessionTarget(sessionId));
    };
    if (opened.has(sessionId)) attach();
    else {
      wire
        .call("sessions", "resync", { session: sessionId })
        .then(
          () => opened.add(sessionId),
          () => {
            if (!cancelled) setFailedFor(sessionId);
          },
        )
        .finally(attach);
    }
    return () => {
      cancelled = true;
      release?.();
    };
  }, [wire, sessionId]);
  const target =
    sessionId === null || sessionId === undefined
      ? undefined
      : sessionTarget(sessionId);
  const view = useStore(
    wire.store,
    (state) =>
      (target === undefined ? undefined : state.targets[target]?.sections) as
        | SessionSections
        | undefined,
  );
  // The host answering `target:missing` is a different answer from staying quiet: the session it
  // was asked for is not registered (never opened, or taken away while watched). That is a no.
  const missing = useStore(wire.store, (state) =>
    target === undefined ? false : state.missing[target] === true,
  );
  return {
    view,
    status:
      view !== undefined
        ? "ready"
        : missing || failedFor === sessionId
          ? "error"
          : "loading",
  };
}

/** One session's view, for the callers that only read what is there. */
export function useSession(
  sessionId: string | null | undefined,
): SessionSections | undefined {
  return useSessionView(sessionId).view;
}

/**
 * The message a session is streaming right now, from its events. The view's own `core.streaming`
 * is only re-sent when a message starts and ends (its revision tracks whether there is one, not
 * what it says), so the words as they grow come from the `message:update` events, which carry the
 * message as it stands. Held until the run ends: the transcript commits it a frame later.
 */
function useStreamedMessage(
  sessionId: string | undefined,
): AgentMessage | undefined {
  const [streamed, setStreamed] = useState<{
    sessionId: string;
    message: AgentMessage | undefined;
  }>();
  useEffect(() => {
    if (sessionId === undefined) return undefined;
    let latest: AgentMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = getWire().onEvent(sessionTarget(sessionId), (event) => {
      if (event.name === "message:update")
        latest = (event.data as { message?: AgentMessage }).message;
      else if (
        event.name === "turn:run-start" ||
        event.name === "turn:run-end" ||
        event.name === "generation:interrupted"
      )
        latest = undefined;
      else return;
      // A token is an event; the page draws a few times a second, not per token.
      timer ??= setTimeout(() => {
        timer = undefined;
        setStreamed({ sessionId, message: latest });
      }, 40);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [sessionId]);
  return streamed?.sessionId === sessionId ? streamed?.message : undefined;
}

/** The run in flight on a session, as blocks to draw: thinking, text and tool calls in order. */
export function useRunBlocks(sessionId: string | undefined) {
  const session = useSession(sessionId);
  const streamed = useStreamedMessage(sessionId);
  const rows = session?.transcript?.messages;
  const streaming = streamed ?? session?.core?.streaming;
  return useMemo(() => runBlocks(rows ?? [], streaming), [rows, streaming]);
}

/**
 * A whole session as blocks, for a task run's log; undefined until the session's view arrives (a
 * run that has not started has no session).
 */
export function useLogBlocks(sessionId: string | null | undefined) {
  const session = useSession(sessionId);
  const streamed = useStreamedMessage(sessionId ?? undefined);
  const rows = session?.transcript?.messages;
  const streaming = streamed ?? session?.core?.streaming;
  return useMemo(
    () => (rows === undefined ? undefined : logBlocks(rows, streaming)),
    [rows, streaming],
  );
}

/** The actions on a session, each as a mutation. */
export function useSessionActions() {
  return {
    goal: useWireMutation<SessionArgs["goal"]>("sessions", "goal"),
    compact: useWireMutation<SessionArgs["compact"]>("sessions", "compact", {
      timeoutMs: 120_000,
    }),
    /**
     * Take one queued message back. The answer is the ack: `already_consumed` means a run reached
     * its tool boundary first and the message is on its way, so the caller must not remove the chip
     * or send it again.
     */
    queueRemove: useWireMutation<
      SessionArgs["queueRemove"],
      {
        entryId: string;
        outcome: "cancelled" | "already_consumed" | "not_found";
      }
    >("sessions", "queueRemove"),
  };
}
