import type {
  AgentView,
  BoardTaskView,
  CaptainIdentitySection,
  ConversationSummary,
  ProjectView,
} from "@eta/client-contracts";
import type { Page } from "../../src/navigation/routes";
import { mount, signal, View } from "nsh";
import { row } from "../../src/components";
import { DesktopSidebar } from "../../src/navigation/sidebar";
import { createHost, Host } from "../../src/services/host";

const now = Date.now();

const agents: AgentView[] = [
  {
    id: "captain",
    name: "Captain",
    instructions: "",
    persona: "",
    runtime: "eta",
    model: "fake:model",
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: "captain",
    avatarSeed: null,
    avatarSeeds: [],
    home: "/home/captain",
    homeProjectId: "project",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "ada",
    name: "Ada",
    instructions: "",
    persona: "",
    runtime: "eta",
    model: "fake:model",
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/home/ada",
    homeProjectId: "project",
    status: "idle",
    createdAt: 0,
    updatedAt: 0,
  },
];

const projects: ProjectView[] = [
  {
    id: "project",
    machineId: "primary",
    path: "/workspace/eta",
    display: "eta",
    name: "eta",
    kind: "project",
    ownerAgentId: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

const captainConversation: ConversationSummary = {
  id: "captain-chat",
  projectId: "project",
  kind: "captain",
  name: "Captain",
  archived: false,
  stewardId: "captain",
  participants: [
    { agentId: "captain", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
  preview: "",
  lastMessageAt: now - 5 * 60_000,
  createdAt: 0,
  updatedAt: now - 5 * 60_000,
};

const captainIdentity: CaptainIdentitySection = {
  agentId: "captain",
  name: "Captain",
  home: "/home/captain",
  model: "fake:model",
  conversationId: "captain-chat",
  createdAt: 0,
  conversation: captainConversation,
};

const conversations: ConversationSummary[] = [
  {
    id: "group-1",
    projectId: "project",
    kind: "group",
    name: "Core team",
    archived: false,
    stewardId: "ada",
    participants: [
      { agentId: "ada", sessionId: null, lastSeq: 1, status: "idle" },
    ],
    lastSeq: 1,
    readSeq: 1,
    unread: 0,
    preview: "",
    lastMessageAt: now,
    createdAt: 0,
    updatedAt: now,
  },
  {
    id: "group-2",
    projectId: "project",
    kind: "group",
    name: "Design review",
    archived: false,
    stewardId: "ada",
    participants: [
      { agentId: "ada", sessionId: null, lastSeq: 1, status: "idle" },
    ],
    lastSeq: 1,
    readSeq: 1,
    unread: 0,
    preview: "",
    lastMessageAt: now - 29 * 60_000,
    createdAt: 0,
    updatedAt: now - 29 * 60_000,
  },
];

const tasks: BoardTaskView[] = [
  {
    id: "task-1",
    number: 480,
    title: "Align desktop sidebar edges",
    status: "in_review",
    createdBy: { kind: "agent", agentId: "ada" },
    assigneeAgentId: "ada",
    conversationId: "group-1",
    runStatus: "completed",
    comments: 0,
    createdAt: now - 10 * 60_000,
    updatedAt: now - 10 * 60_000,
  },
];

function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: list(agents),
      projects: list(projects),
      conversations: list(conversations),
      tasks: list(tasks),
      captain: {
        sections: { identity: captainIdentity },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;

  const page = signal<Page>("chat");
  const selected = signal("group-1");
  const collapsed = signal(false);

  return (
    <Host.Provider value={host}>
      <View style={{ ...row, flex: 1, alignItems: "stretch" }}>
        <DesktopSidebar
          page={page()}
          onNavigate={page.set}
          selected={page() === "chat" ? selected() : ""}
          onConversation={selected.set}
          onCreate={() => {}}
          onArchived={() => {}}
          collapsed={collapsed()}
          onToggle={() => collapsed.set(!collapsed())}
        />
        <View style={{ flex: 1 }} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
