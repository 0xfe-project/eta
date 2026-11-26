import type {
  AgentView,
  BoardTaskView,
  MessageView,
} from "@eta/client-contracts";
import { mount, signal, Text, View, windowSize } from "nsh";
import { ConversationTimeline } from "../../src/pages/chat/conversation-timeline";
import { createHost, Host } from "../../src/services/host";

const agentTemplate: Omit<AgentView, "id" | "name" | "systemRole"> = {
  instructions: "",
  persona: "",
  model: "claude-sonnet",
  runtime: "pi",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  avatarSeed: null,
  avatarSeeds: [],
  home: "",
  homeProjectId: "project",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const captainAgent: AgentView = {
  ...agentTemplate,
  id: "captain-1",
  name: "Captain",
  systemRole: "captain",
};

const adaAgent: AgentView = {
  ...agentTemplate,
  id: "ada",
  name: "Ada",
  systemRole: null,
};

const bolaAgent: AgentView = {
  ...agentTemplate,
  id: "bola",
  name: "Bola",
  systemRole: null,
};

const base = {
  conversationId: "group",
  status: "done" as const,
  revision: 1,
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  createdAt: 0,
  updatedAt: 0,
};

const newCardRow: MessageView = {
  ...base,
  id: "cap-new-1",
  seq: 1,
  kind: "task_card",
  author: "captain",
  agentId: "captain-1",
  mentions: ["ada"],
  text: 'Dispatched task "Ship the Captain patch" to Ada.',
  data: {
    taskId: "task-101",
    number: 101,
    title: "Ship the Captain patch",
    status: "in_progress",
    runStatus: "running",
    conversationId: "group",
    comments: 0,
    summary: "",
    artifacts: [],
    captainAssignmentId: "assign-1",
    captainRound: 1,
    taskNumber: 101,
  },
};

const noteCardRow: MessageView = {
  ...base,
  id: "cap-note-2",
  seq: 2,
  kind: "task_card",
  author: "captain",
  agentId: "captain-1",
  mentions: ["bola"],
  text: "Bola takes Step B after Step A.",
  data: {
    taskId: "task-102",
    number: 102,
    title: "Verify deployment",
    status: "todo",
    runStatus: null,
    conversationId: "group",
    comments: 0,
    summary: "",
    artifacts: [],
    captainAssignmentId: "assign-2",
    captainRound: 1,
    captainNote: "Bola takes Step B after Step A.",
    taskNumber: 102,
  },
};

const legacyDispatchRow: MessageView = {
  ...base,
  id: "cap-legacy-3",
  seq: 3,
  kind: "message",
  author: "captain",
  agentId: "captain-1",
  mentions: ["ada"],
  text: 'Dispatched task "Migrate old timeline" to Ada.',
  data: {
    woke: [],
    joined: [],
    captainAssignmentId: "assign-3",
    captainRound: 1,
    taskId: "task-103",
    taskNumber: 103,
  },
};

const deletedNewRow: MessageView = {
  ...base,
  id: "cap-del-new-4",
  seq: 4,
  kind: "task_card",
  author: "captain",
  agentId: "captain-1",
  mentions: ["ada"],
  text: 'Dispatched task "Removed new task" to Ada.',
  data: {
    taskId: "task-104",
    number: 104,
    title: "Removed new task",
    status: "backlog",
    runStatus: null,
    conversationId: "group",
    comments: 0,
    summary: "",
    artifacts: [],
    captainAssignmentId: "assign-4",
    captainRound: 1,
    taskNumber: 104,
    deleted: true,
  },
};

const deletedLegacyRow: MessageView = {
  ...base,
  id: "cap-del-legacy-5",
  seq: 5,
  kind: "message",
  author: "captain",
  agentId: "captain-1",
  mentions: ["ada"],
  text: 'Dispatched task "Removed legacy task" to Ada.',
  data: {
    woke: [],
    joined: [],
    captainAssignmentId: "assign-5",
    captainRound: 1,
    taskId: "task-105",
    taskNumber: 105,
  },
};

const assignInGroupRow: MessageView = {
  ...base,
  id: "cap-assign-6",
  seq: 6,
  kind: "message",
  author: "captain",
  agentId: "captain-1",
  mentions: ["ada"],
  text: "Please review the release notes.",
  data: {
    woke: ["ada"],
    joined: [],
    captainAssignmentId: "assign-6",
    captainRound: 1,
  },
};

const agentCardRow: MessageView = {
  ...base,
  id: "agent-card-7",
  seq: 7,
  kind: "task_card",
  author: "agent",
  agentId: "ada",
  mentions: [],
  text: "Write unit tests",
  data: {
    taskId: "task-107",
    number: 107,
    title: "Write unit tests",
    status: "done",
    runStatus: "completed",
    conversationId: "group",
    comments: 0,
    summary: "",
    artifacts: [],
  },
};

const tasksList: BoardTaskView[] = [
  {
    id: "task-101",
    number: 101,
    title: "Ship the Captain patch",
    status: "in_progress",
    createdBy: { kind: "agent", agentId: "captain-1" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: "running",
    comments: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "task-102",
    number: 102,
    title: "Verify deployment",
    status: "todo",
    createdBy: { kind: "agent", agentId: "captain-1" },
    assigneeAgentId: "bola",
    conversationId: "group",
    runStatus: null,
    comments: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "task-103",
    number: 103,
    title: "Migrate old timeline",
    status: "done",
    createdBy: { kind: "agent", agentId: "captain-1" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: "completed",
    comments: 0,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "task-107",
    number: 107,
    title: "Write unit tests",
    status: "done",
    createdBy: { kind: "agent", agentId: "ada" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: "completed",
    comments: 0,
    createdAt: 0,
    updatedAt: 0,
  },
];

function Fixture() {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: {
        sections: { list: [captainAgent, adaAgent, bolaAgent] },
        revisions: {},
        version: 0,
      },
      tasks: {
        sections: { list: tasksList },
        revisions: {},
        version: 0,
      },
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
          rows={[
            newCardRow,
            noteCardRow,
            legacyDispatchRow,
            deletedNewRow,
            deletedLegacyRow,
            assignInGroupRow,
            agentCardRow,
          ]}
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
          onTask={(id) => opened.update((list) => [...list, id])}
          onArtifact={noop}
          onWidgetDraft={noop}
          onQuote={noop}
        />
        <Text>{`Opened: ${opened().join(",")}`}</Text>
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
