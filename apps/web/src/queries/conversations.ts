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
  const window = (state?.sections.timeline as TimelineSection | undefined)
    ?.messages;
  const known = useRows((rows) =>
    conversationId === undefined ? NONE : (rows.rows[conversationId] ?? NONE),
  );
  const messages = useMemo(
    () => (window === undefined ? known : mergeRows(known, window)),
    [known, window],
  );
  useEffect(() => {
    if (conversationId !== undefined && window !== undefined)
      rememberRows(conversationId, window);
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
