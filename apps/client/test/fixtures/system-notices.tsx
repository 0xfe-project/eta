import type { MessageView } from "@eta/client-contracts";
import { mount, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { ConversationTimeline } from "../../src/pages/chat/conversation-timeline";
import { createHost, Host } from "../../src/services/host";

// A group's system rows as the host writes them: English for its agents, the event in `data`.
let seq = 0;
function system(text: string, data: Record<string, unknown>): MessageView {
  seq += 1;
  return {
    id: `system-${seq}`,
    conversationId: "group",
    seq,
    kind: "system",
    author: "system",
    status: "done",
    revision: 1,
    agentId: null,
    text,
    thinking: "",
    rootMessageId: null,
    replyToId: null,
    mentions: [],
    createdAt: seq,
    updatedAt: seq,
    data,
  };
}

const rows: MessageView[] = [
  system("Ada is now the steward.", {
    event: "steward",
    from: null,
    to: "ada",
  }),
  system("Bob is now the steward, taking over from Ada.", {
    event: "steward",
    from: "ada",
    to: "bob",
  }),
  system("Bob left the group, which has no steward now.", {
    event: "steward",
    from: "bob",
    to: null,
    reason: "left",
  }),
  system("Cy is no longer the steward.", {
    event: "steward",
    from: "cy",
    to: null,
  }),
  system(
    "This thread has used its 5 wake-ups; later mentions stay in the conversation but wake nobody until the user writes again.",
    { event: "wake_budget", budget: 5 },
  ),
  system("Created by Captain.", { event: "captain_created", agentId: "ada" }),
  system('Routine "Weekly digest" reported: Five launches', {
    event: "routine_report",
    routineId: "routine",
    routineName: "Weekly digest",
    runId: "run",
    title: "Five launches",
  }),
  system("The launch checklist was archived by the host.", {
    event: "checklist_archived",
  }),
  system(
    'Captain proposed the group "Docs revamp". It is made when the user confirms it.',
    {
      event: "captain_proposal",
      kind: "create_group",
      operationId: "op-1",
      proposal: { name: "Docs revamp" },
    },
  ),
];

function Fixture() {
  const host = createHost();
  const agents = [
    { id: "ada", name: "Ada" },
    { id: "bob", name: "Bob" },
    { id: "cy", name: "Cy" },
  ];
  const state = (bobName: string) =>
    host.state.update((s) => ({
      ...s,
      status: "open",
      targets: {
        agents: {
          version: 1,
          revisions: {},
          sections: {
            list: agents.map((agent) =>
              agent.id === "bob" ? { ...agent, name: bobName } : agent,
            ),
          },
        },
        captain: {
          version: 1,
          revisions: {},
          sections: {
            operations: [
              {
                id: "op-1",
                kind: "create_group",
                actorAgentId: "ada",
                requiresApproval: true,
                status: "pending",
                payload: { name: "Docs revamp", memberIds: [] },
                result: null,
                error: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        },
      },
    }));
  state("Bob");
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Button label="Rename Bob" onPress={() => state("Bea")} />
        <ConversationTimeline
          title="Group"
          accessible
          rows={rows}
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
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
