import type {
  ArtifactView,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { Bounds, JSX, ListRef, ViewRef } from "nsh";
import type { TextViewSelectionEvent } from "nsh/base";
import { cleanup, computed, effect, List, Overlay, signal, View } from "nsh";
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
import { wheelScroll } from "../../components/scroll-follow";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { Message } from "./message";
import { questionRowIndex } from "./question-row";
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
  /** Quote what the reader selected in a reply into the composer. */
  onQuote: (conversationId: string, text: string) => void;
  /** A mention's press in a message: its member, by agent id. */
  onMember?: (agentId: string) => void;
}) {
  const host = useHost();
  const c = colors();
  let transcriptList: ListRef | undefined;
  const firstVisibleId = signal<string>();
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
  // The reply text the reader selected, and where: a Quote button floats above it.
  const selection = signal<{
    message: MessageView;
    text: string;
    at: Bounds | ViewRef;
  }>();
  function select(
    message: MessageView,
    event: TextViewSelectionEvent,
    reply: ViewRef | undefined,
  ) {
    const text = event.text.trim();
    // Where the platform gives no box around the selection (the web), the
    // button goes over the reply instead. A phone has its own edit menu.
    const at = event.pageBounds ?? reply;
    if (text && at && !phone()) selection.set({ message, text, at });
    else if (selection()?.message.id === message.id) selection.set(undefined);
  }
  function quote() {
    const current = selection();
    if (!current) return;
    selection.set(undefined);
    props.onQuote(current.message.conversationId, current.text);
  }
  // On Windows the wheel scrolls the list itself, so mouse notches can glide;
  // elsewhere the system already scrolls smoothly and the list keeps it.
  const glide = wheelScroll((offset, animated) =>
    transcriptList?.scrollToOffset({ offset, animated }),
  );
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
          onScroll={(event) => {
            // The button was placed against the selection where it was.
            if (selection()) selection.set(undefined);
            if (onWindows) glide.onScroll(event);
          }}
          onViewableItemsChange={({ viewableItems }) => {
            firstVisibleId.set(viewableItems[0]?.item.id);
          }}
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
                onSelectionChange={(event, reply) =>
                  select(message(), event, reply)
                }
                onMember={props.onMember}
              />
            );
            return onWindows ? <View onWheel={glide.onWheel}>{row}</View> : row;
          }}
        </List>
        <If when={selection()}>
          {(current) => (
            <Overlay
              anchor={current().at}
              placement="top"
              align={"origin" in current().at ? "center" : "end"}
              offset={6}
            >
              <Button
                label={uiText("quoteSelection")}
                icon="return"
                size={28}
                style={{
                  paddingHorizontal: 10,
                  gap: 6,
                  backgroundColor: c().canvas,
                  borderWidth: 1,
                  borderColor: c().border,
                  boxShadow: [{ x: 0, y: 4, blur: 16, color: "#0a0a0a14" }],
                }}
                onPress={quote}
              />
            </Overlay>
          )}
        </If>
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
            <Each of={["agent", "user"] as const}>
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
