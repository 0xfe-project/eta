import type {
  ConversationSummary,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../src/components";
import {
  keyboardFrame,
  mount,
  safeArea,
  signal,
  Text,
  UrlScheme,
  View,
  windowSize,
} from "nsh";
import { Modal, SafeArea } from "../../src/components";
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

const timeline: TimelineSection = {
  messages: [message(1, "user", "ping"), message(2, "agent", "Pong.")],
  hasMore: false,
  held: [],
};

/**
 * Where a view landed against the screen's unsafe edges: the system UI the
 * test simulates (`open`'s `safeArea`) and the keyboard (a stand-in for
 * `keyboardFrame`). Shows "<name>: clear", or the edges it reaches under.
 */
function Where(props: { name: string; view: () => ViewRef | undefined }) {
  const verdict = signal("");
  const look = async () => {
    const at = await props.view()?.measure();
    if (!at) return;
    const safe = safeArea();
    const keyboard = keyboardFrame().height;
    const { width, height } = windowSize();
    const top = at.pagePosition.y;
    const left = at.pagePosition.x;
    const bottom = top + at.bounds.size.height;
    const right = left + at.bounds.size.width;
    const under = [
      top < safe.top && "the status bar",
      left < safe.left && "the left edge",
      right > width - safe.right && "the right edge",
      bottom > height - safe.bottom && "the home indicator",
      bottom > height - keyboard && "the keyboard",
    ].filter(Boolean);
    verdict.set(
      `${props.name}: ${under.length ? `under ${under.join(", ")}` : "clear"}`,
    );
  };
  setTimeout(() => void look(), 50);
  return (
    <If when={verdict()}>
      <Text style={{ position: "absolute", left: 0, top: 0, opacity: 0 }}>
        {verdict()}
      </Text>
    </If>
  );
}

/**
 * The app's root safe area around one surface, picked by the opening URL:
 * eta://fixture/conversation (the conversation page: its header, messages
 * and composer), /drawer (a side drawer over the whole screen, as the
 * conversation's Panel off phones), /sheet (a phone sheet over the tab bar,
 * as Conversation info).
 */
function Fixture() {
  const host = createHost();
  const scenario = UrlScheme.url()?.replace("eta://fixture/", "") ?? "";
  host.state.update((s) => ({
    ...s,
    status: "open",
    targets: {
      ...s.targets,
      conversations: {
        sections: { list: [summary] },
        revisions: {},
        version: 0,
      },
      "conversations.group": {
        sections: { timeline },
        revisions: {},
        version: 0,
      },
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
  let page: ViewRef | undefined;
  let panel: ViewRef | undefined;
  let header: ViewRef | undefined;
  return (
    <Host.Provider value={host}>
      <SafeArea>
        <View
          testID="page"
          style={{ flex: 1 }}
          ref={(node) => {
            page = node;
          }}
        >
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
        <If when={scenario === "conversation"}>
          <Where name="page" view={() => page} />
        </If>
        <If when={scenario === "drawer" || scenario === "sheet"}>
          <Modal
            title="Panel"
            side={scenario === "drawer"}
            sheet={scenario === "sheet"}
            phone={scenario === "sheet"}
            overPhoneNavigation
            width={360}
            height={scenario === "sheet" ? undefined : "100%"}
            headerActions={
              <View
                style={{ width: 8, height: 8 }}
                ref={(node) => {
                  header = node;
                }}
              />
            }
            onClose={noop}
          >
            <View
              testID="panel"
              style={{ flex: 1, minHeight: 100 }}
              ref={(node) => {
                panel = node;
              }}
            />
          </Modal>
          <Where name="panel header" view={() => header} />
          <Where name="panel" view={() => panel} />
        </If>
      </SafeArea>
    </Host.Provider>
  );
}
mount(Fixture);
