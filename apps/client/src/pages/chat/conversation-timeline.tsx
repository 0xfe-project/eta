import type {
  ArtifactView,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { JSX, ListRef, ViewRef } from "nsh";
import type { DeliveryActions } from "./composer-delivery";
import { isCaptainOutcome } from "@eta/client-contracts";
import { cleanup, computed, effect, List, signal, View } from "nsh";
import { onWindows } from "../../app/platform";
import {
  Button,
  colors,
  focusRing,
  grow,
  Label,
  MessagesSkeleton,
  row,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { settled, shownWhile } from "../../components/pending";
import { wheelScroll } from "../../components/scroll-follow";
import { Spinner } from "../../components/spinner";
import { control, icon, opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { Message } from "./message";
import { questionRowIndex } from "./question-row";
import { createQuoteSelection, QuoteSelectionOverlay } from "./quote-selection";
import { isSystemNotice, SystemNotice } from "./system-notice";
import { TaskDraftDetail } from "./task-draft-detail";

export function ConversationTimeline(props: {
  projectName?: string;
  title: string;
  accessible: boolean;
  onAccessLost: () => void;
  onReadDraft?: () => void;
  rows: MessageView[];
  additions: Map<string, MessageView[]>;
  /** The reader's messages on their way, by row id: the rows at the end not taken by the host yet. */
  deliveries?: Map<string, { failure?: string } & DeliveryActions>;
  /**
   * The newest message this window sent that is in the transcript (with `:failed` once it failed).
   * The list does not follow new rows, but one the reader just sent, one the host moved out of the
   * queue, or one that failed is scrolled to, so they see what happened to it.
   */
  sendingId?: string;
  recipients: Map<string, string[]>;
  members: MemberView[];
  /** The conversation's target (`conversations.<id>`), whose state the timeline waits for. */
  target: string;
  loaded: boolean;
  noCachedMessages: boolean;
  hasMessages: boolean;
  hasOlder?: boolean;
  paging: boolean;
  phone: boolean;
  compact?: boolean;
  /** Captain's own conversation: its replies need no name row. */
  captain?: boolean;
  rail?: boolean;
  onPageOlder: () => void;
  onInsert: (message: MessageView) => void;
  /** The message or card whose insert popover is open. */
  insertingId?: string;
  onInsertClose: () => void;
  insertPanel: () => JSX.Element;
  onTask: (id: string) => void;
  onPending?: () => void;
  onArtifact: (artifact: ArtifactView, version?: number) => void;
  onWidgetDraft: (conversationId: string, text: string) => void;
  /** Hands out the function that scrolls to the row of a question's reply. */
  revealer?: (reveal: (replyId: string | null) => void) => void;
  /** The ids of the rows on screen, each time they change. */
  onVisibleRows?: (ids: ReadonlySet<string>) => void;
  /** Quote what the reader selected in a reply into the composer. */
  onQuote: (conversationId: string, text: string) => void;
  /** Re-send the prompt that triggered a completed or failed reply. */
  onRetryReply?: (reply: MessageView) => void;
  /** A mention's press in a message: its member, by agent id. */
  onMember?: (agentId: string) => void;
}) {
  const host = useHost();
  const load = useLoadState({
    targets: () => [props.target],
    ready: () => props.loaded,
  });
  const c = colors();
  let transcriptList: ListRef | undefined;
  const firstVisibleId = signal<string>();
  const phone = () => props.phone;
  // Captain's proposal outcome is context for Captain's next turn; the proposal card
  // already shows how it ended, so the timeline skips it (matching apps/web/src/lib/timeline.ts).
  const rows = computed(() =>
    props.rows.filter((message) => !isCaptainOutcome(message)),
  );
  const sameFailures = computed(() => sameFailureAsNext(rows()));
  // The owning conversation is keyed by id. Always read the current row. Once it is a task card
  // (confirmed here, whose row update may come before the reply, or in another window) the form
  // has nothing left to confirm and closes; the card itself is the way to the task.
  const reading = signal<string>();
  const selected = () => {
    const id = reading();
    return id && props.accessible
      ? rows().find((row) => row.id === id && row.kind === "task_draft")
      : undefined;
  };
  const actions = new Map<string, () => void>();
  // The reply text the reader selected, and where: a Quote button floats above it.
  const quoteSelection = createQuoteSelection({
    phone,
    onQuote: (conversationId, text) => props.onQuote(conversationId, text),
  });
  cleanup(() => quoteSelection.dispose());
  // On Windows the wheel scrolls the list itself, so mouse notches can glide;
  // elsewhere the system already scrolls smoothly and the list keeps it.
  const glide = wheelScroll((offset, animated) =>
    transcriptList?.scrollToOffset({ offset, animated }),
  );
  props.revealer?.((replyId) => {
    const index = questionRowIndex(rows(), replyId);
    if (index !== undefined)
      transcriptList?.scrollToIndex({
        index,
        viewPosition: 0.5,
        animated: true,
      });
  });
  let shownSending: string | undefined;
  effect(() => {
    const id = props.sendingId;
    if (!id || id === shownSending) return;
    shownSending = id;
    // After the row is laid out.
    setTimeout(() => transcriptList?.scrollToEnd({ animated: true }), 0);
  });
  let timelineFocus: ViewRef | undefined;
  let pendingFocus: string | undefined;
  let top: { id: string; offset: number } | undefined;
  let focusTimer: ReturnType<typeof setTimeout>;
  cleanup(() => clearTimeout(focusTimer));

  function readDraft(message: MessageView) {
    pendingFocus = undefined;
    clearTimeout(focusTimer);
    top = undefined;
    const currentRows = rows();
    void transcriptList?.measureScrollPosition().then((position) => {
      const id = position && currentRows[position.index]?.id;
      if (id && reading() === message.id) top = { id, offset: position.offset };
    });
    props.onReadDraft?.();
    reading.set(message.id);
  }
  function closeDraft() {
    const draft = reading();
    if (!draft) return;
    // The row, whether still a draft or by now the task's card: focus goes back to its action.
    const current = rows().find((row) => row.id === draft);
    reading.set(undefined);
    if (top) {
      const { id, offset } = top;
      const index = rows().findIndex((row) => row.id === id);
      if (index >= 0)
        transcriptList?.scrollToIndex({
          index,
          viewOffset: -offset,
          animated: false,
        });
    }
    focusTimer = setTimeout(() => {
      if (!current) {
        timelineFocus?.focus();
        return;
      }
      const focus = actions.get(current.id);
      if (focus) {
        focus();
        return;
      }
      const index = rows().findIndex((row) => row.id === current.id);
      if (index < 0) {
        timelineFocus?.focus();
        return;
      }
      pendingFocus = current.id;
      transcriptList?.scrollToIndex({
        index,
        viewPosition: 0.5,
        animated: false,
      });
    }, 0);
  }
  effect(() => {
    if (!reading()) return;
    if (!props.accessible) {
      reading.set(undefined);
      props.onAccessLost();
    } else if (!selected()) closeDraft();
  });
  function registerAction(id: string, focus: () => void) {
    actions.set(id, focus);
    if (pendingFocus === id) {
      pendingFocus = undefined;
      focusTimer = setTimeout(focus, 0);
    }
    return () => {
      if (actions.get(id) === focus) actions.delete(id);
    };
  }
  // The skeleton, once it appeared, stays its least time before the messages (#380).
  const loaded = settled(() => props.loaded);
  const pagingShown = shownWhile(() => props.paging);
  return (
    <If
      when={loaded() && !props.noCachedMessages}
      else={
        <EmptyState
          size="page"
          status={props.noCachedMessages ? "error" : load.shown()}
          loading={
            <MessagesSkeleton
              label={uiText("loadingConversation")}
              style={{ ...grow, overflow: "hidden" }}
            />
          }
          error={
            !props.noCachedMessages && load.failure() === "missing"
              ? {
                  tone: "quiet",
                  title: uiText("conversationCannotOpen"),
                  description: uiText("conversationCannotOpenHint"),
                  actions: [
                    {
                      label: uiText("back"),
                      icon: "arrowLeft",
                      onPress: props.onAccessLost,
                    },
                  ],
                }
              : props.noCachedMessages || load.failure() === "offline"
                ? {
                    art: "offline",
                    title: uiText("lostTheConnectionToTheHost"),
                    description: uiText("agentsKeepRunningOnTheHost"),
                    retry: load.retry,
                    retrying: load.retrying(),
                  }
                : {
                    title: uiText("conversationDidNotLoad"),
                    description: load.why(),
                    retry: load.retry,
                    retrying: load.retrying(),
                  }
          }
          empty={{ title: uiText("noMessagesYet") }}
        />
      }
    >
      <View
        role="region"
        focusable
        accessibilityLabel={props.title}
        ref={(node) => {
          timelineFocus = node;
        }}
        style={{ ...grow, position: "relative" }}
      >
        <List
          style={grow}
          ref={(node) => {
            transcriptList = node;
          }}
          each={rows()}
          keyExtractor={(message) => message.id}
          initialScrollAtEnd
          // design-value: a virtual list's first guess at a row's height, not a drawn size
          estimatedItemSize={134}
          scrollEventThrottle={onWindows ? 16 : undefined}
          onScroll={(event) => {
            // The button was placed against the selection where it was.
            quoteSelection.dismiss();
            if (onWindows) glide.onScroll(event);
          }}
          onViewableItemsChange={({ viewableItems }) => {
            firstVisibleId.set(viewableItems[0]?.item.id);
            props.onVisibleRows?.(
              new Set(viewableItems.map((token) => token.item.id)),
            );
          }}
          contentStyle={{
            paddingLeft: space[16],
            paddingRight: props.rail ? space[64] : space[16],
            // The header's slot stays, empty, with a gap after it: take that
            // gap back while there is nothing older to load.
            paddingTop: (phone() ? 16 : 12) - (props.hasOlder ? 0 : 12),
            paddingBottom: space[12],
            gap: space[12],
          }}
          header={() => (
            <If when={props.hasOlder}>
              <View style={{ alignItems: "center" }}>
                <View
                  role="button"
                  accessibilityLabel={uiText("loadEarlierMessages")}
                  accessibilityState={{ busy: props.paging }}
                  onPress={() => {
                    if (!props.paging) props.onPageOlder();
                  }}
                  hoverStyle={{ opacity: opacity.muted }}
                  focusVisibleStyle={focusRing(c())}
                  style={{
                    ...row,
                    gap: space[8],
                    paddingVertical: space[4],
                    cursor: props.paging ? "default" : "pointer",
                  }}
                >
                  <If when={pagingShown()}>
                    <Spinner size={icon.sm} tone="muted" />
                  </If>
                  <Label variant="small" tone="muted">
                    {uiText("loadEarlierMessages")}
                  </Label>
                </View>
              </View>
            </If>
          )}
          empty={() => (
            <EmptyState
              size="page"
              status="empty"
              loading={null}
              error={null}
              empty={
                props.captain
                  ? {
                      art: "captain",
                      title: uiText("noCaptainMessagesYet"),
                      description: uiText("noCaptainMessagesYetHint"),
                    }
                  : {
                      art: "chats",
                      title: uiText("noMessagesYet"),
                      description: uiText("noMessagesYetHint"),
                    }
              }
            />
          )}
        >
          {(message) => {
            const row = (
              <If
                when={!isSystemNotice(message())}
                else={<SystemNotice item={message()} phone={phone()} />}
              >
                <Message
                  item={message()}
                  onReadDraft={readDraft}
                  registerAction={registerAction}
                  additions={props.additions.get(message().id) ?? []}
                  canInsert={
                    host.state().status === "open" &&
                    props.recipients.has(message().id)
                  }
                  onInsert={() => props.onInsert(message())}
                  inserting={props.insertingId === message().id}
                  onInsertClose={props.onInsertClose}
                  insertPanel={props.insertPanel}
                  sameFailureAsNext={sameFailures().has(message().id)}
                  delivery={props.deliveries?.get(message().id)}
                  phone={phone()}
                  compact={props.compact}
                  captain={props.captain}
                  members={props.members}
                  onTask={props.onTask}
                  onPending={props.onPending}
                  onArtifact={props.onArtifact}
                  onWidgetDraft={(text) =>
                    props.onWidgetDraft(message().conversationId, text)
                  }
                  onSelectionChange={(event, reply) =>
                    quoteSelection.select(message(), event, reply)
                  }
                  onRetry={
                    props.onRetryReply
                      ? () => props.onRetryReply?.(message())
                      : undefined
                  }
                  onMember={props.onMember}
                />
              </If>
            );
            return onWindows ? <View onWheel={glide.onWheel}>{row}</View> : row;
          }}
        </List>
        <QuoteSelectionOverlay controller={quoteSelection} />
        <If when={selected()}>
          {(message) => (
            <TaskDraftDetail
              message={message()}
              projectName={props.projectName}
              phone={phone()}
              onClose={closeDraft}
            />
          )}
        </If>
        <If when={props.rail && props.hasMessages}>
          <View
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              flexDirection: "row",
              gap: space[2],
            }}
          >
            <Each of={["agent", "user"] as const}>
              {(author) => {
                const entries = () =>
                  rows()
                    .map((message, index) => ({ message, index }))
                    .filter((entry) => entry.message.author === author())
                    .slice(-12);
                return (
                  <View style={{ gap: space[2] }}>
                    <Each of={entries()} key={(entry) => entry.message.id}>
                      {(entry, index) => (
                        <Button
                          label={`${author() === "user" ? "Prompt" : "Reply"} ${index() + 1}`}
                          size={control.sm}
                          iconOnly
                          selected={firstVisibleId() === entry().message.id}
                          icon={author() === "user" ? "chat" : "info"}
                          tone="ghost"
                          onPress={() => {
                            transcriptList?.scrollToIndex({
                              index: entry().index,
                              viewPosition: 0,
                              animated: true,
                            });
                          }}
                        />
                      )}
                    </Each>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </View>
    </If>
  );
}

// Failures of the host or of the member's environment, which fail everything
// waiting at once.
const environmentFailures = new Set(["restart", "unavailable"]);

/** Failed replies whose next reply, from the same member, failed the same
 * environment way: those say "for the reason below" instead of repeating it. */
function sameFailureAsNext(rows: MessageView[]) {
  const replies = rows.filter(
    (message) => message.author === "agent" && message.kind === "message",
  );
  const ids = new Set<string>();
  replies.forEach((message, index) => {
    const next = replies[index + 1];
    const code = String(message.data.code ?? "");
    if (
      message.status === "failed" &&
      environmentFailures.has(code) &&
      next?.agentId === message.agentId &&
      next.status === "failed" &&
      next.data.code === code
    )
      ids.add(message.id);
  });
  return ids;
}
