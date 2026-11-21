import type {
  ConversationSummary,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, UrlScheme, View, windowSize } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "Ada",
  participants: [
    { agentId: "Ada", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const message = (
  seq: number,
  author: MessageView["author"],
  text: string,
): MessageView => ({
  id: `m${seq}`,
  conversationId: "group",
  seq,
  kind: "message",
  author,
  status: "done",
  revision: 1,
  agentId: author === "agent" ? "Ada" : null,
  text,
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  mentions: [],
  createdAt: 0,
  updatedAt: 0,
  data: {},
});

/**
 * The conversation page in one of its states, picked by the opening URL:
 * eta://fixture/loading (no timeline yet), /empty, /short, /offline (a phone
 * that lost the host before any message arrived).
 */
function Fixture() {
  const host = createHost();
  const scenario = UrlScheme.url()?.replace("eta://fixture/", "") ?? "";
  const timeline: TimelineSection | undefined =
    scenario === "empty"
      ? { messages: [], hasMore: false, held: [] }
      : scenario === "short"
        ? {
            messages: [
              message(1, "user", "ping"),
              message(2, "agent", "Pong."),
            ],
            hasMore: false,
            held: [],
          }
        : undefined;
  host.state.update((s) => ({
    ...s,
    status: scenario === "offline" ? "reconnecting" : "open",
    targets: {
      ...s.targets,
      conversations: {
        sections: { list: [summary] },
        revisions: {},
        version: 0,
      },
      ...(timeline
        ? {
            "conversations.group": {
              sections: { timeline },
              revisions: {},
              version: 0,
            },
          }
        : {}),
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Conversation
          id="group"
          layout={layout()}
          onTask={noop}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
