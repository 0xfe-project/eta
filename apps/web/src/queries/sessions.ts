import type {
  AgentMessage,
  CompactResult,
  SessionArgs,
  SessionImage,
  SessionViewSections,
  ViewMessageRow,
} from "@eta/client-contracts";
import type { LogBlock, RunImage } from "@/lib/run";
import type { RunTiming } from "@/lib/run-timing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { logBlocks, runBlocks } from "@/lib/run";
import { replyRows, runFromOfCall, runTiming } from "@/lib/run-timing";
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

/**
 * The run in flight on a session, as blocks to draw: thinking, text and tool calls in order.
 * `runFrom` is where the run starts in the session, from the reply's row. A view that has nothing
 * past it has not caught up with the run, so what it says is streaming is the last run's (the
 * events are this run's: they only arrive while the page listens).
 */
export function useRunBlocks(
  sessionId: string | undefined,
  runFrom?: number | undefined,
) {
  const session = useSession(sessionId);
  const streamed = useStreamedMessage(sessionId);
  const rows = session?.transcript?.messages;
  const behind = runFrom !== undefined && (rows?.at(-1)?.seq ?? 0) <= runFrom;
  const streaming = streamed ?? (behind ? undefined : session?.core?.streaming);
  return useMemo(
    () => runBlocks(rows ?? [], streaming, runFrom),
    [rows, streaming, runFrom],
  );
}

/** How many older messages one page back asks for: the size of the view's own window. */
const HISTORY_PAGE = 200;

/** A session's log, with the messages older than the view's window as far back as it has paged. */
export interface SessionLog {
  /** Undefined until the session's view arrives (a run that has not started has no session). */
  blocks: LogBlock[] | undefined;
  /** Messages exist before the oldest one the page has. */
  earlier: boolean;
  /** A page back is on its way. */
  loadingEarlier: boolean;
  /** Ask for the page before the oldest message the page has. */
  loadEarlier: () => void;
  /** What each running call has printed so far, by call id. */
  progress: ReadonlyMap<string, string>;
  /** The rows the blocks are drawn from, oldest first (for the run's timing). */
  rows: readonly ViewMessageRow[] | undefined;
  /** The message being streamed, if one is. */
  streaming: AgentMessage | undefined;
}

/**
 * The view keeps the newest 200 messages; a log reads the whole session. Older pages come from
 * `sessions.history` when the reader scrolls up to them, and every row the window has shown is
 * kept too, so a long run that pushes rows out of the window while the reader is paging does not
 * leave a hole between the two.
 */
export function useSessionLog(
  sessionId: string | null | undefined,
): SessionLog {
  const session = useSession(sessionId);
  const streamed = useStreamedMessage(sessionId ?? undefined);
  const progress = useToolProgress(sessionId ?? undefined);
  const window = session?.transcript?.messages;
  const before = session?.transcript?.messagesBefore ?? 0;
  const streaming = streamed ?? session?.core?.streaming;
  const [older, setOlder] = useState<{
    sessionId: string;
    rows: readonly ViewMessageRow[];
    /** The host had no more: a page came back short. */
    done: boolean;
    loading: boolean;
  }>();
  const pages = older?.sessionId === sessionId ? older : undefined;
  const seenRef = useRef<{
    sessionId: string;
    rows: Map<string, ViewMessageRow>;
  }>(undefined);
  const rows = useMemo(() => {
    if (window === undefined || sessionId === null || sessionId === undefined)
      return undefined;
    if (seenRef.current?.sessionId !== sessionId)
      seenRef.current = { sessionId, rows: new Map() };
    const kept = seenRef.current.rows;
    for (const row of window) kept.set(row.entryId, row);
    if (pages === undefined && kept.size === window.length) return window;
    const all = new Map(kept);
    for (const row of pages?.rows ?? []) all.set(row.entryId, row);
    return [...all.values()].sort((a, b) => a.seq - b.seq);
  }, [window, pages, sessionId]);
  const oldestInWindow = window?.[0]?.seq ?? Infinity;
  const olderHeld = rows?.filter((row) => row.seq < oldestInWindow).length ?? 0;
  const earlier = pages?.done !== true && olderHeld < before;
  const oldest = rows?.[0]?.seq;
  const loadEarlier = useCallback(() => {
    if (sessionId === null || sessionId === undefined) return;
    if (!earlier || pages?.loading === true || oldest === undefined) return;
    setOlder({
      sessionId,
      rows: pages?.rows ?? [],
      done: false,
      loading: true,
    });
    getWire()
      .call<{ rows?: ViewMessageRow[] }>("sessions", "history", {
        session: sessionId,
        beforeSeq: oldest,
        limit: HISTORY_PAGE,
      })
      .then(
        (page) => {
          const got = page.rows ?? [];
          setOlder((was) =>
            was?.sessionId === sessionId
              ? {
                  sessionId,
                  rows: [...got, ...was.rows],
                  done: got.length < HISTORY_PAGE,
                  loading: false,
                }
              : was,
          );
        },
        () =>
          setOlder((was) =>
            was?.sessionId === sessionId ? { ...was, loading: false } : was,
          ),
      );
  }, [sessionId, earlier, pages, oldest]);
  const blocks = useMemo(
    () => (rows === undefined ? undefined : logBlocks(rows, streaming)),
    [rows, streaming],
  );
  return {
    blocks,
    earlier,
    loadingEarlier: pages?.loading === true,
    loadEarlier,
    progress,
    rows,
    streaming,
  };
}

/**
 * Where a group reply's run spent its time, from its member's session: the rows after `runFrom`
 * (the place in the session the reply's row names, or for a finished one, where the call it kept
 * was made) up to the next reply's briefing, or — for a
 * reply at work, which runs to `now` — everything after it. Undefined when the session view no
 * longer holds the run (it keeps the newest 200 messages) or its rows carry no times.
 */
export function useReplyTiming(
  sessionId: string | undefined,
  savedRunFrom: number | undefined,
  now: number | undefined,
  /** One of the calls a finished reply kept: where its run is, when its row lost `runFrom`. */
  callId?: string | undefined,
): RunTiming | undefined {
  const session = useSession(sessionId);
  const streamed = useStreamedMessage(sessionId);
  const rows = session?.transcript?.messages;
  const live = now !== undefined;
  const streaming = live ? (streamed ?? session?.core?.streaming) : undefined;
  return useMemo(() => {
    if (rows === undefined) return undefined;
    const runFrom =
      savedRunFrom ??
      (live || callId === undefined ? undefined : runFromOfCall(rows, callId));
    // A run that started before the oldest row the view holds is not all there.
    if (runFrom !== undefined && (rows[0]?.seq ?? 0) > runFrom + 1)
      return undefined;
    const own =
      runFrom !== undefined
        ? replyRows(rows, runFrom)
        : live
          ? rows.slice(lastUserIndex(rows))
          : undefined;
    return own === undefined
      ? undefined
      : runTiming(own, { streaming, ...(live ? { now } : {}) });
  }, [rows, savedRunFrom, callId, live, streaming, now]);
}

/** Where the newest user message is (the briefing of the run in flight); 0 when there is none. */
function lastUserIndex(rows: readonly ViewMessageRow[]): number {
  for (let at = rows.length - 1; at >= 0; at -= 1)
    if (rows[at]!.message.role === "user") return at;
  return 0;
}

/** The time, every second while `live`; undefined otherwise. */
export function useNow(live: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    // At once, then every second: the time the hook was mounted at may be long gone.
    const first = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [live]);
  return live ? now : undefined;
}

/** No call is printing anything. */
const NO_PROGRESS: ReadonlyMap<string, string> = new Map();

/**
 * What the calls at work have printed so far, from the session's `tool:update` events (a Codex
 * command streams its output; a call that prints nothing until it ends has none). A call's entry
 * goes when it ends, because its result is in the transcript from then on.
 */
function useToolProgress(
  sessionId: string | undefined,
): ReadonlyMap<string, string> {
  const [progress, setProgress] = useState<{
    sessionId: string;
    outputs: ReadonlyMap<string, string>;
  }>();
  useEffect(() => {
    if (sessionId === undefined) return undefined;
    const outputs = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = getWire().onEvent(sessionTarget(sessionId), (event) => {
      const data = event.data as
        | {
            toolCallId?: unknown;
            partialResult?: { content?: { type?: string; text?: string }[] };
          }
        | undefined;
      if (
        event.name === "tool:update" &&
        typeof data?.toolCallId === "string"
      ) {
        const text = (data.partialResult?.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        if (text === "") return;
        outputs.set(data.toolCallId, text);
      } else if (
        event.name === "tool:end" &&
        typeof data?.toolCallId === "string"
      )
        outputs.delete(data.toolCallId);
      else if (event.name === "turn:run-end") outputs.clear();
      else return;
      timer ??= setTimeout(() => {
        timer = undefined;
        setProgress({ sessionId, outputs: new Map(outputs) });
      }, 100);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [sessionId]);
  return progress !== undefined && progress.sessionId === sessionId
    ? progress.outputs
    : NO_PROGRESS;
}

/** Pictures fetched from the host, by session, row and part: a picture never changes. */
const pictures = new Map<string, Promise<string>>();

/**
 * A picture as something an `<img>` can show. One the view carried whole is shown as it is; one
 * it left out (to keep the view small) is asked for once with `sessions.image`, when `wanted` says
 * it is on screen, and kept for the rest of the page's life.
 */
export function useSessionImage(
  sessionId: string | null | undefined,
  image: RunImage,
  wanted = true,
): { src: string | undefined; failed: boolean } {
  const inline =
    image.data === ""
      ? undefined
      : `data:${image.mimeType};base64,${image.data}`;
  const key =
    sessionId === null || sessionId === undefined
      ? undefined
      : `${sessionId}:${image.entryId}:${image.index}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    src?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    if (
      !wanted ||
      inline !== undefined ||
      key === undefined ||
      sessionId === null ||
      sessionId === undefined
    )
      return undefined;
    let cancelled = false;
    let request = pictures.get(key);
    if (request === undefined) {
      request = getWire()
        .call<SessionImage>("sessions", "image", {
          session: sessionId,
          entryId: image.entryId,
          index: image.index,
        })
        .then((picture) => `data:${picture.mimeType};base64,${picture.data}`);
      // A failed fetch is not kept: the next time the picture is drawn it asks again.
      request.catch(() => pictures.delete(key));
      pictures.set(key, request);
    }
    request.then(
      (src) => {
        if (!cancelled) setLoaded({ key, src });
      },
      () => {
        if (!cancelled) setLoaded({ key, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wanted, inline, key, sessionId, image.entryId, image.index]);
  if (inline !== undefined) return { src: inline, failed: false };
  const mine = loaded?.key === key ? loaded : undefined;
  return { src: mine?.src, failed: mine?.failed === true };
}

/** The actions on a session, each as a mutation. */
export function useSessionActions() {
  return {
    goal: useWireMutation<SessionArgs["goal"]>("sessions", "goal"),
    compact: useWireMutation<SessionArgs["compact"], CompactResult>(
      "sessions",
      "compact",
      // A runtime's compaction takes as long as it takes: what a daemon is given for one.
      { timeoutMs: 10 * 60 * 1000 },
    ),
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
