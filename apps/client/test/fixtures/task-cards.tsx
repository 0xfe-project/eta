import type { BoardTaskView, MessageView } from "@eta/client-contracts";
import { mount, signal, Text, View, windowSize } from "nsh";
import { ConversationTimeline } from "../../src/pages/chat/conversation-timeline";
import { createHost, Host } from "../../src/services/host";

const base = {
  mentions: [] as string[],
  conversationId: "group",
  author: "agent",
  status: "done",
  revision: 1,
  agentId: "Ada",
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  createdAt: 0,
  updatedAt: 0,
} satisfies Partial<MessageView>;

const card: MessageView = {
  ...base,
  id: "card-1",
  seq: 1,
  kind: "task_card",
  text: "Write the changelog",
  data: { taskId: "task-5", number: 5, title: "Write the changelog" },
};

const draft: MessageView = {
  ...base,
  id: "draft-1",
  seq: 2,
  kind: "task_draft",
  text: "Footer regression test",
  data: {
    title: "Footer regression test",
    description: "Wrap the footer links under 360px.",
    workspace: "local",
  },
};

const task: BoardTaskView = {
  id: "task-5",
  number: 5,
  title: "Write the changelog",
  status: "done",
  createdBy: { kind: "agent", agentId: "Ada" },
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: "completed",
  comments: 0,
  createdAt: 0,
  updatedAt: 0,
};

function Fixture() {
  const host = createHost();
  host.state.update((s) => ({
    ...s,
    status: "open",
    targets: {
      ...s.targets,
      tasks: { sections: { list: [task] }, revisions: {}, version: 0 },
    },
  }));
  host.call = async <T,>() => undefined as T;
  const opened = signal<string[]>([]);
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <ConversationTimeline
          title="Group"
          accessible
          rows={[card, draft]}
          additions={new Map()}
          recipients={new Map()}
          members={[]}
          loaded
          noCachedMessages={false}
          hasMessages
          paging={false}
          phone={windowSize().width < 600}
          onAccessLost={noop}
          onPageOlder={noop}
          onInsert={noop}
          onInsertClose={noop}
          insertPanel={() => <View />}
          onTask={(id) => opened.update((list) => [...list, id])}
          onArtifact={noop}
          onWidgetDraft={noop}
        />
        <Text>{`Opened: ${opened().join(",")}`}</Text>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
