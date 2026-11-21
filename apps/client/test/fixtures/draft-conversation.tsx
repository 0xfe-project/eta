import type { MessageView } from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { ConversationTimeline } from "../../src/pages/chat/conversation-timeline";
import { createHost, Host } from "../../src/services/host";

const draft: MessageView = {
  id: "draft-1",
  conversationId: "group",
  seq: 1,
  kind: "task_draft",
  author: "agent",
  status: "done",
  revision: 1,
  agentId: "Ada",
  text: "Legacy title",
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  mentions: [],
  createdAt: 0,
  updatedAt: 0,
  data: {
    description:
      "## Scope\n\nKeep the order.\n\n## Acceptance criteria\n\nRead the last item.",
    workspace: "local",
  },
};

function Fixture() {
  const host = createHost();
  host.state.update((s) => ({ ...s, status: "open" }));
  const sample = { ...draft };
  const scenario = UrlScheme.url();
  if (scenario === "eta://fixture/rich")
    sample.data = {
      title: "Exhibit labels",
      description:
        "## Scope\n\n" +
        Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}`).join(
          "\n\n",
        ),
      assignee: "Lin",
      base: "review/labels",
      workspace: "worktree",
      status: "backlog",
      parentId: "parent",
      dependsOn: [
        { taskId: "first", requireDone: true },
        { taskId: "second", requireDone: false },
      ],
    };
  if (scenario === "eta://fixture/empty") {
    sample.data = {};
    sample.agentId = null;
    sample.text = "";
  }
  const calls = signal<string[]>([]);
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((log) => [
      ...log,
      `${target}.${action} ${JSON.stringify(args)}`,
    ]);
    return undefined as T;
  };
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <ConversationTimeline
          title="Group"
          accessible
          rows={[sample]}
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
          onTask={noop}
          onArtifact={noop}
          onWidgetDraft={noop}
        />
        <Text>{`Calls: ${calls().length}`}</Text>
        <Each of={calls()} key="index">
          {(call) => <Text>{call()}</Text>}
        </Each>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
