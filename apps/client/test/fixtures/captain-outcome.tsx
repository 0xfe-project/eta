import type { CaptainOperationView, MessageView } from "@eta/client-contracts";
import { mount, signal, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { ConversationTimeline } from "../../src/pages/chat/conversation-timeline";
import { createHost, Host } from "../../src/services/host";

let seq = 0;
function row(
  kind: MessageView["kind"],
  text: string,
  data: Record<string, unknown>,
): MessageView {
  seq += 1;
  return {
    id: `row-${seq}`,
    conversationId: "captain-chat",
    seq,
    kind,
    author: "system",
    status: "done",
    revision: 1,
    agentId: null,
    text,
    thinking: "",
    rootMessageId: null,
    replyToId: null,
    mentions: [],
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    data,
  };
}

const outcomeRow = row(
  "message",
  [
    'Your proposed group "nsh-awesome" (operation 74a66481-1111-4222-8333-444444444444) was confirmed by the user and created.',
    "conversationId: 68d72847-0000-4000-8000-000000000000",
    "projectId: proj-1 (/home/akrc/Developer/nsh-awesome was added as a new project)",
  ].join("\n"),
  {
    captainOutcome: {
      operationId: "op-applied",
      kind: "create_group",
      status: "applied",
    },
  },
);

const legacyOutcomeRow = row(
  "message",
  'Your proposed group "legacy-group" (operation 74a66481-2222-4222-8333-444444444444) was rejected by the user. Nothing was created.',
  {},
);

const reviewRow = row(
  "message",
  '<captain-review>\n1. [assignment_settled] Release notes are ready for review.\n{"taskNumber":7}\n</captain-review>',
  {
    captainReview: { reviewIds: ["rev-1"] },
  },
);

const proposalApplied = row(
  "system",
  'Captain proposed the group "nsh-awesome". It is made when the user confirms it.',
  {
    event: "captain_proposal",
    kind: "create_group",
    operationId: "op-applied",
    proposal: { name: "nsh-awesome" },
  },
);

const proposalRejected = row(
  "system",
  'Captain proposed the group "old-group". It is made when the user confirms it.',
  {
    event: "captain_proposal",
    kind: "create_group",
    operationId: "op-rejected",
    proposal: { name: "old-group" },
  },
);

const proposalFailed = row(
  "system",
  'Captain proposed the group "broken-group". It is made when the user confirms it.',
  {
    event: "captain_proposal",
    kind: "create_group",
    operationId: "op-failed",
    proposal: { name: "broken-group" },
  },
);

const allRows: MessageView[] = [
  proposalApplied,
  outcomeRow,
  proposalRejected,
  legacyOutcomeRow,
  proposalFailed,
  reviewRow,
];

const operations: CaptainOperationView[] = [
  {
    id: "op-applied",
    kind: "create_group",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "applied",
    payload: {
      name: "nsh-awesome",
      path: "/home/akrc/Developer/nsh-awesome",
      memberIds: ["ada"],
    },
    result: {
      conversationId: "68d72847-0000-4000-8000-000000000000",
      projectId: "proj-1",
      projectCreated: true,
    },
    error: null,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "op-rejected",
    kind: "create_group",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "rejected",
    payload: {
      name: "old-group",
      path: "/home/akrc/Developer/old-group",
      memberIds: ["ada"],
    },
    result: null,
    error: null,
    createdAt: 3,
    updatedAt: 4,
  },
  {
    id: "op-failed",
    kind: "create_group",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "failed",
    payload: {
      name: "broken-group",
      path: "/home/akrc/missing",
      memberIds: ["ada"],
    },
    result: null,
    error: "ENOENT: /home/akrc/missing does not exist",
    createdAt: 5,
    updatedAt: 6,
  },
];

function Fixture() {
  const host = createHost();
  const onlyOutcome = signal(false);
  host.state.update((s) => ({
    ...s,
    status: "open",
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: {
          list: [{ id: "ada", name: "Ada" }],
        },
      },
      captain: {
        version: 1,
        revisions: {},
        sections: {
          operations,
        },
      },
    },
  }));
  const rows = () => (onlyOutcome() ? [outcomeRow] : allRows);
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Button label="Only outcome" onPress={() => onlyOutcome.set(true)} />
        <ConversationTimeline
          title="Captain"
          accessible
          captain
          rows={rows()}
          additions={new Map()}
          recipients={new Map()}
          members={[]}
          target="conversations.captain-chat"
          loaded
          noCachedMessages={false}
          hasMessages={rows().length > 0}
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
