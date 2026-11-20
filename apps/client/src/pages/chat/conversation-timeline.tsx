import type {
  ArtifactView,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { JSX, ListRef } from "nsh";
import { computed, List, signal, View } from "nsh";
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

export function ConversationTimeline(props: {
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
  onArtifact: (artifact: ArtifactView, version?: number) => void;
  onWidgetDraft: (conversationId: string, text: string) => void;
}) {
  const host = useHost();
  const c = colors();
  let transcriptList: ListRef | undefined;
  const markedMessage = signal("");
  const phone = () => props.phone;
  const sameFailures = computed(() => sameFailureAsNext(props.rows));
  return (
    <If
      when={props.loaded && !props.noCachedMessages}
      else={
        <If
          when={props.noCachedMessages}
          else={<MessagesSkeleton label={uiText("loadingConversation")} />}
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
      <View style={{ ...grow, position: "relative" }}>
        <List
          style={grow}
          ref={(node) => {
            transcriptList = node;
          }}
          each={props.rows}
          keyExtractor={(message) => message.id}
          initialScrollAtEnd
          estimatedItemSize={134}
          maintainVisibleContentPosition={{
            autoscrollToBottomThreshold: 40,
          }}
          scrollbar={false}
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
                  <Label size={12} line={16} tone="muted">
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
          {(message) => (
            <Message
              item={message()}
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
              onArtifact={props.onArtifact}
              onWidgetDraft={(text) =>
                props.onWidgetDraft(message().conversationId, text)
              }
            />
          )}
        </List>
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
