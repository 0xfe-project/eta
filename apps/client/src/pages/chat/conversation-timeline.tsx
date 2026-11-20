import type {
  ArtifactView,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { ListRef } from "nsh";
import { List, signal, View } from "nsh";
import { Button, Empty, grow, Label } from "../../components";
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
  rail?: boolean;
  onPageOlder: () => void;
  onInsert: (message: MessageView) => void;
  onTask: (id: string) => void;
  onArtifact: (artifact: ArtifactView, version?: number) => void;
  onWidgetDraft: (conversationId: string, text: string) => void;
}) {
  const host = useHost();
  let transcriptList: ListRef | undefined;
  const markedMessage = signal("");
  const phone = () => props.phone;
  return (
    <If
      when={props.loaded && !props.noCachedMessages}
      else={
        <If
          when={props.noCachedMessages}
          else={<Empty title={uiText("loadingConversation")} />}
        >
          <Empty
            title={uiText("lostTheConnectionToTheHost")}
            description={uiText("agentsKeepRunningOnTheHost")}
            icon="refresh"
          >
            <Button
              label={uiText("retry")}
              icon="refresh"
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
                <Button
                  label={uiText("loadEarlierMessages")}
                  disabled={props.paging}
                  onPress={props.onPageOlder}
                />
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
              phone={phone()}
              compact={props.compact}
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
