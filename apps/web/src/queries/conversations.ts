import type {
  ConversationArgs,
  ConversationInfo,
  ConversationResults,
  ConversationSummary,
  HistoryResult,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { mergeRows } from "@/lib/timeline";
import { useListTarget, useTarget, useWireMutation } from "@/queries/wire";

// Conversations on the wire: the `conversations` list (eager, so the sidebar draws from `hello`)
// and one target per conversation (`conversations.<id>`: its facts, its members and the newest
// window of its timeline). The timeline is read through a store of every row this page has seen,
// so a window that moves on does not take the rows it passed with it.

/** Every conversation, archived ones too; the caller decides what to show. */
export function useConversationList() {
  const { items, loaded, error } =
    useListTarget<ConversationSummary>("conversations");
  return { conversations: items, loaded, error };
}

const NONE: readonly MessageView[] = [];

/** The rows seen per conversation, by `seq`. */
const useRows = create<{ rows: Record<string, readonly MessageView[]> }>(
  () => ({ rows: {} }),
);

/**
 * Forget rows, and the replies that belong to them. What a recall takes out: the message was never
 * a message, so the page is not losing anything it was shown.
 */
export function forgetRows(
  conversationId: string,
  ids: readonly string[],
): void {
  const gone = new Set(ids);
  useRows.setState((state) => {
    const known = state.rows[conversationId];
    if (known === undefined) return state;
    const kept = known.filter(
      (row) =>
        !gone.has(row.id) &&
        !gone.has(row.rootMessageId ?? "") &&
        !gone.has(row.replyToId ?? ""),
    );
    return kept.length === known.length
      ? state
      : { rows: { ...state.rows, [conversationId]: kept } };
  });
}

/** Keep rows the page learned of outside the target: an older page, what a `send` answered. */
export function rememberRows(
  conversationId: string,
  rows: readonly MessageView[],
): void {
  useRows.setState((state) => {
    const known = state.rows[conversationId] ?? NONE;
    const merged = mergeRows(known, rows);
    return merged === known
      ? state
      : { rows: { ...state.rows, [conversationId]: merged } };
  });
}

/** How many rows `conversations.history` is asked for at a time. */
const PAGE = 50;

export interface ConversationState {
  /** The conversation's target has delivered. */
  loaded: boolean;
  info: ConversationInfo | undefined;
  /** Everything seen, oldest first. */
  messages: readonly MessageView[];
  /** Written, but waiting for a lane: not in the conversation yet. */
  held: readonly MessageView[];
  /** Rows before the oldest one seen exist (seqs are dense from 1). */
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  /** Why the last page could not be read. */
  error: Error | undefined;
}

/**
 * One conversation: its facts and its timeline. The newest window arrives with the target and
 * stays live; `loadOlder` pages back from the oldest row seen with `conversations.history`.
 */
export function useConversation(
  conversationId: string | undefined,
): ConversationState {
  const state = useTarget(
    conversationId === undefined
      ? undefined
      : `conversations.${conversationId}`,
  );
  const info = state?.sections.info as ConversationInfo | undefined;
  const timeline = state?.sections.timeline as TimelineSection | undefined;
  const window = timeline?.messages;
  const held = timeline?.held ?? NONE;
  const known = useRows((rows) =>
    conversationId === undefined ? NONE : (rows.rows[conversationId] ?? NONE),
  );
  /*
   * A message that is waiting for a lane is not in the conversation yet, and the reply queued for
   * it is not either: the chip above the composer is where the whole thing belongs until a lane
   * takes it. The host leaves the message out of its window, but not the reply rows waiting under
   * it (they carry no `held` of their own), and a `send` answers with both, so the filtering has to
   * happen here rather than on the way in — otherwise the transcript draws a turn with nothing in
   * it, and one after a reload that the `send` never came through to explain.
   *
   * Only a reply whose message is the one waiting is hidden. A message already in the transcript
   * with a member still busy keeps its waiting line: that turn happened, and the queue behind it is
   * part of it.
   */
  const waitingOn = useMemo(() => new Set(held.map((row) => row.id)), [held]);
  const messages = useMemo(() => {
    const seen = window === undefined ? known : mergeRows(known, window);
    if (waitingOn.size === 0) return seen;
    const shown = seen.filter(
      (row) =>
        row.author !== "agent" || !waitingOn.has(row.rootMessageId ?? ""),
    );
    return shown.length === seen.length ? seen : shown;
  }, [known, window, waitingOn]);
  useEffect(() => {
    if (conversationId === undefined || window === undefined) return;
    rememberRows(conversationId, window);
    if (window.length === 0) return;
    /*
     * Inside the span the window covers, the window is the whole truth: it is the newest rows the
     * host has, and a row missing from it is not a message — it is waiting for a lane, or it was
     * recalled, or a compaction dropped it. Union alone kept those alive forever: the same words
     * as a message and as a chip, or a reply row with nothing in it.
     *
     * Outside the span nothing is dropped: rows the page pulled in from an older page are below
     * it, and a message sent a moment ago can be above it until the next window arrives.
     */
    const seqs = window.map((row) => row.seq);
    const from = Math.min(...seqs);
    const to = Math.max(...seqs);
    const present = new Set(window.map((row) => row.id));
    useRows.setState((state) => {
      const known = state.rows[conversationId];
      if (known === undefined) return state;
      const kept = known.filter(
        (row) => row.seq < from || row.seq > to || present.has(row.id),
      );
      return kept.length === known.length
        ? state
        : { rows: { ...state.rows, [conversationId]: kept } };
    });
  }, [conversationId, window]);

  const history = useWireMutation<ConversationArgs["history"], HistoryResult>(
    "conversations",
    "history",
    {
      onSuccess: (page) => rememberRows(page.conversationId, page.messages),
    },
  );
  const oldest = messages[0]?.seq;
  const { mutate, isPending } = history;
  return {
    loaded: state !== undefined,
    info,
    messages,
    held,
    hasOlder: oldest !== undefined && oldest > 1,
    loadingOlder: isPending,
    loadOlder: () => {
      if (conversationId === undefined || oldest === undefined || isPending)
        return;
      mutate({ conversationId, beforeSeq: oldest, limit: PAGE });
    },
    error: history.error ?? undefined,
  };
}

/** The actions on a conversation, each as a mutation. (`send` has its own path: see outbox.ts.) */
export function useConversationActions() {
  return {
    create: useWireMutation<
      ConversationArgs["create"],
      ConversationResults["create"]
    >("conversations", "create"),
    update: useWireMutation<
      ConversationArgs["update"],
      ConversationResults["update"]
    >("conversations", "update"),
    invite: useWireMutation<
      ConversationArgs["invite"],
      ConversationResults["invite"]
    >("conversations", "invite"),
    remove: useWireMutation<
      ConversationArgs["remove"],
      ConversationResults["remove"]
    >("conversations", "remove"),
    setSteward: useWireMutation<
      ConversationArgs["setSteward"],
      ConversationResults["setSteward"]
    >("conversations", "setSteward"),
    /**
     * Take back a message that is still waiting for a lane. `recalled: false` means a lane took it:
     * the words are in the conversation now and putting them back in the box would say them twice.
     */
    recall: useWireMutation<
      ConversationArgs["recall"],
      { conversationId: string; recalled: boolean }
    >("conversations", "recall", {
      // The message and the reply that was waiting on it are gone from the host. Forgetting them
      // here is what keeps the transcript from leaving a row with nothing in it.
      onSuccess: (result, args) => {
        if (result.recalled) forgetRows(args.conversationId, [args.messageId]);
      },
    }),
    read: useWireMutation<
      ConversationArgs["read"],
      ConversationResults["read"]
    >("conversations", "read"),
    stop: useWireMutation<
      ConversationArgs["stop"],
      ConversationResults["stop"]
    >("conversations", "stop", {
      // The rows as the stop left them, so the stopped reply does not wait for the next push.
      onSuccess: (result, args) =>
        rememberRows(args.conversationId, result.stopped),
    }),
  };
}
