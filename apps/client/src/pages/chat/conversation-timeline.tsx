import type {
  ArtifactView,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { JSX, ListRef, ViewRef, WheelEvent } from "nsh";
import {
  cleanup,
  computed,
  effect,
  List,
  reduceMotion,
  signal,
  View,
} from "nsh";
import { onWindows } from "../../app/platform";
import {
  Button,
  colors,
  Empty,
  focusRing,
  grow,
  Label,
  MessagesSkeleton,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { Message } from "./message";
import { questionRowIndex } from "./question-row";
import {
  animateFollow,
  wheelDistance,
  wheelIsNotch,
  wheelTarget,
} from "./scroll-follow";
import { TaskDraftDetail } from "./task-draft-detail";

export function ConversationTimeline(props: {
  projectName?: string;
  title: string;
  accessible: boolean;
  onAccessLost: () => void;
  onReadDraft?: () => void;
  rows: MessageView[];
  additions: Map<string, MessageView[]>;
  recipients: Map<string, string[]>;
  members: MemberView[];
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
  /** The user message whose insert popover is open. */
  insertingId?: string;
  onInsertClose: () => void;
  insertPanel: () => JSX.Element;
  onTask: (id: string) => void;
  onPending?: () => void;
  onArtifact: (artifact: ArtifactView, version?: number) => void;
  onWidgetDraft: (conversationId: string, text: string) => void;
  /** Hands out the function that scrolls to the row of a question's reply. */
  revealer?: (reveal: (replyId: string | null) => void) => void;
}) {
  const host = useHost();
  const c = colors();
  let transcriptList: ListRef | undefined;
  const markedMessage = signal("");
  const phone = () => props.phone;
  const sameFailures = computed(() => sameFailureAsNext(props.rows));
  // The owning conversation is keyed by id. Always read the current row, including a remote confirmation.
  const reading = signal<string>();
  const selected = () => {
    const id = reading();
    return id && props.accessible
      ? props.rows.find(
          (row) =>
            row.id === id &&
            (row.kind === "task_draft" || row.kind === "task_card"),
        )
      : undefined;
  };
  const actions = new Map<string, () => void>();
  // On Windows the wheel scrolls the list itself, so mouse notches can glide;
  // elsewhere the system already scrolls smoothly and the list keeps it.
  // No scroll event yet: the end is not known, and the list clamps to it.
  let scrolled = { offset: 0, max: Number.POSITIVE_INFINITY };
  let wheel: { aim?: number; last: number } = { last: 0 };
  function onWheel(event: WheelEvent) {
    // The list scrolls along its own axis only.
    if (Math.abs(event.delta.x) > Math.abs(event.delta.y)) return;
    const now = Date.now();
    const target = wheelTarget({
      ...scrolled,
      aim: wheel.aim,
      last: wheel.last,
      now,
      distance: wheelDistance(event),
    });
    const glide = wheelIsNotch(event) && animateFollow(reduceMotion());
    wheel = { aim: glide ? target : undefined, last: now };
    transcriptList?.scrollToOffset({ offset: target, animated: glide });
  }
  props.revealer?.((replyId) => {
    const index = questionRowIndex(props.rows, replyId);
    if (index !== undefined)
      transcriptList?.scrollToIndex({
        index,
        viewPosition: 0.5,
        animated: true,
      });
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
    const rows = props.rows;
    void transcriptList?.measureScrollPosition().then((position) => {
      const id = position && rows[position.index]?.id;
      if (id && reading() === message.id) top = { id, offset: position.offset };
    });
    props.onReadDraft?.();
    reading.set(message.id);
  }
  function closeDraft() {
    const draft = reading();
    if (!draft) return;
    const current = selected();
    reading.set(undefined);
    if (top) {
      const { id, offset } = top;
      const index = props.rows.findIndex((row) => row.id === id);
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
      const index = props.rows.findIndex((row) => row.id === current.id);
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
  return (
    <If
      when={props.loaded && !props.noCachedMessages}
      else={
        <If
          when={props.noCachedMessages}
          else={
            <MessagesSkeleton
              label={uiText("loadingConversation")}
              style={{ ...grow, overflow: "hidden" }}
            />
          }
        >
          <Empty
            title={uiText("lostTheConnectionToTheHost")}
            description={uiText("agentsKeepRunningOnTheHost")}
            icon="linkBreak"
            iconSize={28}
            iconTone="ink"
            titleWeight={600}
          >
            <Button
              label={uiText("retry")}
              icon="refresh"
              size={32}
              style={{ marginTop: 8, paddingHorizontal: 12, gap: 6 }}
              onPress={host.reconnect}
            />
          </Empty>
        </If>
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
          each={props.rows}
          keyExtractor={(message) => message.id}
          initialScrollAtEnd
          estimatedItemSize={134}
          scrollbar={false}
          scrollEventThrottle={onWindows ? 16 : undefined}
          onScroll={
            onWindows
              ? (event) => {
                  scrolled = {
                    offset: event.offset.y,
                    max: event.contentSize.height - event.size.height,
                  };
                }
              : undefined
          }
          contentStyle={{
            paddingLeft: 16,
            paddingRight: props.rail ? 60 : 16,
            // The header's slot stays, empty, with a gap after it: take that
            // gap back while there is nothing older to load.
            paddingTop: (phone() ? 16 : 12) - (props.hasOlder ? 0 : 12),
            paddingBottom: 12,
            gap: 12,
          }}
          header={() => (
            <If when={props.hasOlder}>
              <View style={{ alignItems: "center" }}>
                <View
                  role="button"
                  accessibilityLabel={uiText("loadEarlierMessages")}
                  accessibilityState={{ disabled: props.paging }}
                  onPress={() => {
                    if (!props.paging) props.onPageOlder();
                  }}
                  hoverStyle={{ opacity: 0.7 }}
                  focusVisibleStyle={focusRing(c())}
                  style={{
                    paddingVertical: 4,
                    opacity: props.paging ? 0.45 : 1,
                    cursor: props.paging ? "default" : "pointer",
                  }}
                >
                  <Label variant="small" tone="muted">
                    {uiText("loadEarlierMessages")}
                  </Label>
                </View>
              </View>
            </If>
          )}
          empty={() => (
            <Label tone="muted" style={{ padding: 16 }}>
              {uiText("noMessagesYet")}
            </Label>
          )}
        >
          {(message) => {
            const row = (
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
              />
            );
            return onWindows ? <View onWheel={onWheel}>{row}</View> : row;
          }}
        </List>
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
              gap: 3,
            }}
          >
            <Each of={["assistant", "user"] as const}>
              {(author) => {
                const entries = () =>
                  props.rows
                    .map((message, index) => ({ message, index }))
                    .filter((entry) => entry.message.author === author())
                    .slice(-12);
                return (
                  <View style={{ gap: 3 }}>
                    <Each of={entries()} key={(entry) => entry.message.id}>
                      {(entry, index) => (
                        <Button
                          label={`${author() === "user" ? "Prompt" : "Reply"} ${index() + 1}`}
                          size={20}
                          iconOnly
                          selected={markedMessage() === entry().message.id}
                          icon={author() === "user" ? "chat" : "info"}
                          tone="ghost"
                          onPress={() => {
                            markedMessage.set(entry().message.id);
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
