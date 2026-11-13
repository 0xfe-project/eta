/** The conversation tab: the transcript, the messages waiting their turn, the reply status, the input. */
import type { MessageView } from "@eta/client-contracts";
import type { DOMElement } from "ink";
import type { TabRef } from "../../config/types";
import type { ComposerState } from "./composer";
import type { TranscriptItem } from "./contract";
import type { Feed } from "./feed/store";
import type { OutgoingMessage } from "./send";
import type { TranscriptMode } from "./transcript/transcript";
import { Box, Text, useBoxMetrics } from "ink";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { formatKeyBinding } from "../../config/keys";
import { runCommandLine } from "../../extensions/command-line";
import { useConfig, useRegistry, useShell } from "../../extensions/react";
import { useLocale, useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { Composer, emptyComposer } from "./composer";
import { showDraft } from "./composer/state";
import { namedMembers, replyingNames } from "./facts";
import { feedFor, feedItems } from "./feed/store";
import { conversationMessages } from "./messages";
import { projectFiles } from "./project-files";
import { renderItem } from "./render";
import { markRead, sendMessage, stopReplies } from "./send";
import { sentDraft } from "./sent-draft";
import { createItemKeeper } from "./stable-items";
import { drawWidths } from "./transcript/frames";
import { useRenderedItems } from "./transcript/render-cache";
import { Transcript as TranscriptColumn } from "./transcript/transcript";
import { isExpanded } from "./transcript/ui";

// The input's state lives in the same `ui` as the transcript's; drawn apart, a key typed into the
// input does not lay the transcript out again.
const Transcript = memo(TranscriptColumn);

const HELD_MARK = "⧗ ";
const NO_ITEMS: readonly TranscriptItem[] = [];
const STATUS_SEPARATOR = " · ";

/** Draws one conversation tab, following the conversation on the host while it is in front. */
export function ConversationView({
  tab,
  active,
}: {
  tab: TabRef;
  active: boolean;
}) {
  const ctx = useShell();
  const wire = ctx.wire;
  const feed = feedFor(wire, tab.id);
  const t = useMessages(conversationMessages);
  const muted = inkColor(useConfig().theme.muted);
  useEffect(() => (active ? feed.attach() : undefined), [feed, active]);
  const missing = useStore(
    wire.store,
    (state) => state.missing[`conversations.${tab.id}`] === true,
  );
  const loaded = useStore(feed.store, (state) => state.loaded);
  if (missing) return <Text>{t("missing")}</Text>;
  if (!loaded) return <Text color={muted}>{t("loading")}</Text>;
  return <LoadedConversation feed={feed} active={active} />;
}

function LoadedConversation({ feed, active }: { feed: Feed; active: boolean }) {
  const ctx = useShell();
  const registry = useRegistry();
  const config = useConfig();
  const locale = useLocale();
  const t = useMessages(conversationMessages);
  const wire = ctx.wire;
  const id = feed.conversationId;
  const muted = inkColor(config.theme.muted);

  const state = useStore(feed.store);
  const { rows, members, agents, info, sessions, held, ui } = state;
  const [keepItems] = useState(createItemKeeper);
  const reviewBinding = config.keybindings["review.open"][0];
  const reviewKey =
    reviewBinding === undefined ? undefined : formatKeyBinding(reviewBinding);
  const { expanded, expandAll } = ui;
  const unfolded = useCallback(
    (key: string) => isExpanded({ expanded, expandAll }, key),
    [expanded, expandAll],
  );
  const stepsOpen =
    config.transcript.toolCalls === "collapsed" ? unfolded : undefined;
  const items = useMemo(
    () =>
      keepItems(
        feedItems(
          { rows, members, agents, info, sessions },
          locale,
          reviewKey,
          stepsOpen,
        ),
      ),
    [
      keepItems,
      rows,
      members,
      agents,
      info,
      sessions,
      locale,
      reviewKey,
      stepsOpen,
    ],
  );
  const named = useMemo(
    () => namedMembers({ members, agents }),
    [members, agents],
  );
  const replying = useMemo(
    () => replyingNames({ rows, agents }),
    [rows, agents],
  );
  const canSend = useStore(wire.store, (s) =>
    s.ops.includes("conversations.send"),
  );

  const boxRef = useRef<DOMElement>(null);
  const { width, height, hasMeasured } = useBoxMetrics(boxRef);
  const measured = hasMeasured && width > 0;
  const drawn = useRenderedItems(
    renderItem,
    drawWidths,
    measured ? items : NO_ITEMS,
    {
      width,
      previewLines: config.toolOutput.previewLines,
      theme: config.theme,
      locale,
    },
    unfolded,
  );
  const below = useBelowTranscript(items, drawn?.items, held, replying);

  const { scroll, search } = ui;
  const transcriptUi = useMemo(
    () => ({ scroll, expanded, expandAll, search }),
    [scroll, expanded, expandAll, search],
  );
  const [mode, setMode] = useState<TranscriptMode>("normal");
  useReadMark(feed, active, ui.scroll.follow);

  const onReachTop = useCallback(
    () => ctx.reportFailure(feed.loadOlder()),
    [ctx, feed],
  );
  // Keyed by the project alone, so a new message does not make the composer ask again.
  const projectId = info?.projectId;
  const loadFiles = useCallback(
    () =>
      projectId === undefined
        ? Promise.resolve([])
        : projectFiles(wire, id, projectId),
    [wire, id, projectId],
  );
  const composerState =
    (ui.composer as ComposerState | undefined) ?? emptyComposer();
  const send = (message: OutgoingMessage) =>
    ctx.reportFailure(
      sendMessage(ctx, id, message).catch((error: unknown) => {
        restoreDraft(feed, message);
        throw error;
      }),
    );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box ref={boxRef} flexGrow={1} flexBasis={0} overflow="hidden">
        {measured && drawn !== undefined && drawn.items !== NO_ITEMS && (
          <Transcript
            items={drawn.items}
            rendered={drawn.rendered}
            height={height}
            // The drawing follows the measured width a step behind; the frames are put together at
            // the width the items were drawn for.
            width={drawn.width}
            isActive={active}
            ui={transcriptUi}
            onUi={feed.setUi}
            hasOlder={state.hasOlder}
            // A page that came is not among the drawn items until the drawing catches up.
            loadingOlder={state.loadingOlder || drawn.items !== items}
            onReachTop={onReachTop}
            onNotify={ctx.notify}
            onModeChange={setMode}
          />
        )}
      </Box>
      {/* One row each, never squeezed: on a short terminal the transcript gives up its rows first. */}
      {below.held.map((message) => (
        <Box key={message.id} flexShrink={0}>
          <Text color={muted} wrap="truncate-end">
            {HELD_MARK + (message.text.split("\n")[0] ?? "")}
          </Text>
        </Box>
      ))}
      {below.replying.length > 0 && (
        <Box flexShrink={0}>
          <Text color={muted} wrap="truncate-end">
            {replyStatus(below.replying, config.keybindings, t)}
          </Text>
        </Box>
      )}
      {canSend ? (
        <Composer
          state={composerState}
          onState={(next) => feed.setUi({ composer: next })}
          width={Math.max(1, width)}
          active={active && mode === "normal"}
          replying={replying.length > 0}
          completeCommand={registry.complete}
          members={named}
          loadFiles={loadFiles}
          onSend={send}
          onCommand={(line) => void runCommandLine(line, registry, ctx)}
          onStop={() => ctx.reportFailure(stopReplies(wire, id))}
          onPanel={() => ctx.selectPinnedTab()}
        />
      ) : (
        <Text color={muted} wrap="truncate-end">
          {t("hostTooOld")}
        </Text>
      )}
    </Box>
  );
}

/** What the view draws between the transcript and the input. */
interface BelowTranscript {
  held: readonly MessageView[];
  replying: readonly string[];
}

/**
 * The held messages and who is replying as they were when `drawnItems` were made. The transcript
 * draws a step behind its items, so drawing these from the newest state would show a reply over,
 * or a held message gone, before the transcript shows what took their place. Before the first
 * drawing, and for items not made here, it is the newest.
 */
function useBelowTranscript(
  items: readonly TranscriptItem[],
  drawnItems: readonly TranscriptItem[] | undefined,
  held: readonly MessageView[],
  replying: readonly string[],
): BelowTranscript {
  const [byItems] = useState(
    () => new WeakMap<readonly TranscriptItem[], BelowTranscript>(),
  );
  const newest = useMemo(() => ({ held, replying }), [held, replying]);
  byItems.set(items, newest);
  return (
    (drawnItems === undefined ? undefined : byItems.get(drawnItems)) ?? newest
  );
}

type Texts = ReturnType<
  typeof useMessages<keyof (typeof conversationMessages)["en"]>
>;

/** `<names> is replying · <stop key> to stop · <steer key> to steer`, leaving out an unbound key. */
function replyStatus(
  names: readonly string[],
  keybindings: ReturnType<typeof useConfig>["keybindings"],
  t: Texts,
): string {
  const stopKey = keybindings["reply.stop"][0];
  const steerKey = keybindings["message.steer"][0];
  return [
    t(names.length === 1 ? "replyingOne" : "replyingMany", {
      names: names.join(t("nameSeparator")),
    }),
    ...(stopKey ? [t("stopKey", { key: formatKeyBinding(stopKey) })] : []),
    ...(steerKey ? [t("steerKey", { key: formatKeyBinding(steerKey) })] : []),
  ].join(STATUS_SEPARATOR);
}

/** A message the host did not take goes back into the input, unless something new is typed there. */
function restoreDraft(feed: Feed, message: OutgoingMessage): void {
  const current =
    (feed.store.getState().ui.composer as ComposerState | undefined) ??
    emptyComposer();
  if (current.text !== "") return;
  feed.setUi({
    composer: showDraft(current, sentDraft(message.text, message.pastes)),
  });
}

/** Moves the read mark to the newest row while the view is in front and follows the bottom. */
function useReadMark(feed: Feed, active: boolean, following: boolean): void {
  const { wire } = useShell();
  const info = useStore(feed.store, (state) => state.info);
  const lastSeq = info?.lastSeq ?? 0;
  const readSeq = info?.readSeq ?? 0;
  useEffect(() => {
    if (active && following && lastSeq > readSeq)
      markRead(wire, feed.conversationId, lastSeq);
  }, [wire, feed, active, following, lastSeq, readSeq]);
}
