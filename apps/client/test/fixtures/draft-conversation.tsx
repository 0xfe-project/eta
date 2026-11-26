import type { MessageView } from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
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
  // A description as agents and the old plain box wrote it: `*` bullets, `1)`, a table,
  // snake_case, a hard tab.
  if (scenario === "eta://fixture/legacy")
    sample.data = {
      title: "Login page",
      description:
        "Goal: the login page lays out right in Safari.\n\n### Steps\n* reproduce on Safari 18\n* fix `login_form` padding\n\n| browser | ok |\n| --- | --- |\n| Safari | no |\n\n1) keep snake_case names\n2) ship",
      workspace: "local",
    };
  if (scenario === "eta://fixture/discarded")
    sample.data = { ...sample.data, discarded: true };
  if (scenario === "eta://fixture/empty") {
    sample.data = {};
    sample.agentId = null;
    sample.text = "";
  }
  const calls = signal<string[]>([]);
  const rows = signal<MessageView[]>([sample]);
  // The host's reply to a confirmation, held until "Reply" is pressed: as over
  // the wire, the row's own update (now the task's card) comes first.
  let reply: (() => void) | undefined;
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((log) => [
      ...log,
      `${target}.${action} ${JSON.stringify(args)}`,
    ]);
    if (action !== "confirmDraft") return undefined as T;
    if (scenario === "eta://fixture/refused")
      throw new Error("no such task: base");
    const edits = (args as { edits: { title: string; status: string } }).edits;
    rows.set([
      { ...sample, kind: "task_card", data: { taskId: "task-7" }, revision: 2 },
    ]);
    await new Promise<void>((resolve) => {
      reply = resolve;
    });
    return {
      task: {
        id: "task-7",
        number: 7,
        title: edits.title,
        status: edits.status,
      },
      message: rows()[0],
    } as T;
  };
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <ConversationTimeline
          title="Group"
          accessible
          rows={rows()}
          additions={new Map()}
          recipients={new Map()}
          members={[]}
          target="conversations.fixture"
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
          onQuote={noop}
        />
        <Button label="Reply" onPress={() => reply?.()} />
        <Text>{`Calls: ${calls().length}`}</Text>
        <Each of={calls()} key="index">
          {(call) => <Text>{call()}</Text>}
        </Each>
        <NotificationHost />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
