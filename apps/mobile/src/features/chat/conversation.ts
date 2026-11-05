// One conversation for the screen: its facts, its rows and what is at work in it. Same reading as
// apps/web/src/queries/conversations.ts.

import type {
  ConversationInfo,
  ConversationSummary,
  HistoryResult,
  MemberView,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { RunBlock } from "./run";
import { computed, effect, signal, untracked } from "nsh";
import {
  agentById,
  conversations,
  interactions,
  projectById,
} from "../../app/lists";
import { useTarget, call } from "../../wire/target";
import {
  ACTIVE_STATUSES,
  RUNNING_STATUSES,
  mergeRows,
  rememberRows,
  rowsOf,
  settleWindow,
  taskRowsByTurn,
} from "./rows";
import { runFromOf, savedTools } from "./run";
import { useSessions } from "./session";

/** How many rows `conversations.history` is asked for at a time. */
const PAGE = 50;

const NONE: readonly MessageView[] = [];

export const agentName = (id: string | null | undefined): string =>
  agentById(id)?.name ?? "";

export type Chat = ReturnType<typeof useChat>;

export function useChat(id: string) {
  const target = useTarget(`conversations.${id}`);
  const info = () => target.section<ConversationInfo>("info");
  const timeline = () => target.section<TimelineSection>("timeline");
  const summary = computed((): ConversationSummary | undefined =>
    conversations().find((conversation) => conversation.id === id),
  );
  const members = computed(
    (): readonly MemberView[] =>
      target.section<MemberView[]>("members") ?? summary()?.participants ?? [],
  );
  const kind = () => summary()?.kind ?? info()?.kind;
  const direct = () => kind() === "direct";
  const stewardId = () => info()?.stewardId ?? summary()?.stewardId ?? null;
  const held = computed(() => timeline()?.held ?? NONE);

  effect(() => {
    const window = timeline()?.messages;
    if (window !== undefined) untracked(() => settleWindow(id, window));
  });

  // A message waiting for a lane is not in the conversation yet, and neither is the reply queued
  // for it: the band over the composer is where both belong until a lane takes it.
  const messages = computed(() => {
    const known = rowsOf(id)();
    const window = timeline()?.messages;
    const seen = window === undefined ? known : mergeRows(known, window);
    const waiting = new Set(held().map((row) => row.id));
    return waiting.size === 0
      ? seen
      : seen.filter(
          (row) =>
            row.author !== "agent" || !waiting.has(row.rootMessageId ?? ""),
        );
  });
  const grouped = computed(() => taskRowsByTurn(messages()));

  const sessions = useSessions(() =>
    members().flatMap((member) =>
      member.sessionId === null ? [] : [member.sessionId],
    ),
  );
  const sessionOf = (agentId: string | null) =>
    members().find((member) => member.agentId === agentId)?.sessionId ??
    undefined;

  /** The reply in progress; later ones wait behind it. */
  const active = computed(() =>
    messages().find(
      (message) =>
        message.author === "agent" &&
        ACTIVE_STATUSES.has(message.status) &&
        message.status !== "stopping",
    ),
  );

  /** Questions this conversation's runs are standing still on. */
  const questions = computed(() =>
    interactions().filter(
      (interaction) =>
        interaction.status === "pending" && interaction.conversationId === id,
    ),
  );

  const oldest = () => messages()[0]?.seq;
  const hasOlder = () => {
    const seq = oldest();
    return seq !== undefined && seq > 1;
  };
  const loadingOlder = signal(false);
  const olderError = signal<string | undefined>(undefined);
  const loadOlder = () => {
    const before = untracked(oldest);
    if (before === undefined || before <= 1 || untracked(loadingOlder)) return;
    loadingOlder.set(true);
    olderError.set(undefined);
    call<HistoryResult>("conversations", "history", {
      conversationId: id,
      beforeSeq: before,
      limit: PAGE,
    }).then(
      (page) => {
        rememberRows(id, page.messages);
        loadingOlder.set(false);
      },
      (error: unknown) => {
        olderError.set(error instanceof Error ? error.message : String(error));
        loadingOlder.set(false);
      },
    );
  };

  // Rows are recycled, so what a reader opened is kept here, by row, not in the row.
  const folds = signal<Record<string, boolean>>({});
  const fold = (key: string, open: boolean) =>
    folds.update((all) => ({ ...all, [key]: open }));

  return {
    id,
    summary,
    info,
    members,
    direct,
    kind,
    stewardId,
    projectName: () =>
      projectById(summary()?.projectId ?? info()?.projectId)?.name,
    /** The conversation's timeline has come. */
    loaded: () => timeline() !== undefined,
    missing: () => target.missing(),
    messages,
    grouped,
    held,
    sessions,
    sessionOf,
    active,
    questions,
    hasOlder,
    loadingOlder,
    olderError,
    loadOlder,
    folds,
    fold,
  };
}

/** Whether a reply's run is what its session is on now: not when it merely waits its turn. */
const isRunning = (message: MessageView) =>
  RUNNING_STATUSES.has(message.status);

/** A finished reply's process as blocks: what it worked through, then what it did. */
function savedBlocks(message: MessageView): RunBlock[] {
  return [
    ...(message.thinking === ""
      ? []
      : [
          {
            type: "thinking" as const,
            id: `${message.id}:thinking`,
            text: message.thinking,
          },
        ]),
    ...savedTools(message.data),
  ];
}

/** The blocks of a reply: from its session while it runs, from its row once it ended. Reactive. */
export function replyBlocks(
  chat: Chat,
  message: MessageView,
): { live: boolean; blocks: RunBlock[] } {
  const session = isRunning(message)
    ? chat.sessionOf(message.agentId)
    : undefined;
  return session === undefined
    ? { live: false, blocks: savedBlocks(message) }
    : {
        live: true,
        blocks: chat.sessions.blocks(session, runFromOf(message.data)),
      };
}
