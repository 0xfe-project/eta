import type {
  AgentRuntimeInfo,
  AgentView,
  BoardTaskDetail,
  CaptainOperationView,
  ConversationSummary,
  MachineView,
  ProjectView,
  ProvidersView,
  TaskRunView,
} from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View } from "nsh";
import { Button } from "../../src/components";
import { Proposal } from "../../src/pages/chat/approvals";
import { InviteAgents } from "../../src/pages/chat/members";
import { NewConversation } from "../../src/pages/new-conversation";
import { ConversationMembers } from "../../src/pages/new-conversation/conversation-members";
import { AgentEditor } from "../../src/pages/settings/agents/editor";
import { AgentSetting } from "../../src/pages/settings/setting-row";
import { NewTask } from "../../src/pages/tasks/new-task";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { createHost, Host } from "../../src/services/host";

const now = Date.now();

const machines: MachineView[] = [
  {
    id: "m-primary",
    name: "studio",
    kind: "primary",
    status: "online",
    fingerprint: null,
    home: null,
    os: "linux",
    maxActiveRuns: 2,
    createdAt: now,
    lastSeenAt: now,
    version: null,
    platform: "linux-x64",
    install: null,
    protocol: null,
    updateError: null,
    tailnetNode: null,
    build: null,
  },
  {
    id: "m-daemon",
    name: "gpu-box",
    kind: "daemon",
    status: "online",
    fingerprint: null,
    home: null,
    os: "linux",
    maxActiveRuns: 2,
    createdAt: now,
    lastSeenAt: now,
    version: null,
    platform: "linux-x64",
    install: null,
    protocol: null,
    updateError: null,
    tailnetNode: null,
    build: null,
  },
];

const providers: ProvidersView = {
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      hasApiKey: true,
      models: [{ id: "sonnet", name: "Sonnet", reasoning: true }],
    },
  ],
} as unknown as ProvidersView;

const runtimes: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    models: [{ id: "sonnet", name: "Sonnet", default: true, efforts: [] }],
  },
];

const agents: AgentView[] = [
  {
    id: "a-eta",
    name: "Ada",
    instructions: "Help everywhere",
    persona: "Executor",
    runtime: "eta",
    model: "anthropic:sonnet",
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/ada",
    homeProjectId: "p-home-eta",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "a-ext-primary",
    name: "PrimaryClaude",
    instructions: "Work on studio",
    persona: "legacy-should-hide",
    runtime: "claude",
    model: "claude:sonnet",
    thinkingLevel: null,
    machineId: "m-primary",
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/primary-claude",
    homeProjectId: "p-home-cody",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "a-ext-daemon",
    name: "DaemonAcp",
    instructions: "Work on gpu-box",
    persona: "",
    runtime: "acp.fake",
    model: null,
    thinkingLevel: null,
    machineId: "m-daemon",
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/daemon-acp",
    homeProjectId: "p-home-acp",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "a-ext-null",
    name: "BrokenNullClaude",
    instructions: "Missing pin",
    persona: "",
    runtime: "claude",
    model: null,
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/broken",
    homeProjectId: "p-home-broken",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "a-ext-missing-model",
    name: "ExtMissingModel",
    instructions: "Missing model",
    persona: "",
    runtime: "claude",
    model: "claude:removed",
    thinkingLevel: null,
    machineId: "m-primary",
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/ext-missing",
    homeProjectId: "p-home-ext-missing",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "a-eta-missing-model",
    name: "EtaMissingModel",
    instructions: "Missing eta model",
    persona: "",
    runtime: "eta",
    model: "anthropic:removed",
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: null,
    avatarSeeds: [],
    home: "/agents/eta-missing",
    homeProjectId: "p-home-eta-missing",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
];

const projects: ProjectView[] = [
  {
    id: "p-primary",
    machineId: "m-primary",
    path: "/work/studio-app",
    display: "/work/studio-app",
    name: "Studio App",
    kind: "project",
    ownerAgentId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "p-daemon",
    machineId: "m-daemon",
    path: "/work/gpu-job",
    display: "/work/gpu-job",
    name: "GPU Job",
    kind: "project",
    ownerAgentId: null,
    archived: false,
    createdAt: now,
    updatedAt: now,
  },
];

const primaryGroup: ConversationSummary = {
  id: "c-primary",
  projectId: "p-primary",
  kind: "group",
  name: "Studio Team",
  stewardId: "a-eta",
  archived: false,
  unread: 0,
  readSeq: 0,
  lastSeq: 0,
  preview: "",
  lastMessageAt: null,
  participants: [
    { agentId: "a-eta", sessionId: null, lastSeq: 0, status: "idle" },
    { agentId: "a-ext-primary", sessionId: null, lastSeq: 0, status: "idle" },
    { agentId: "a-ext-daemon", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  createdAt: now,
  updatedAt: now,
};

const run: TaskRunView = {
  id: "r1",
  agentId: null,
  status: "completed",
  queueReason: null,
  machineId: "m-primary",
  sessionId: "s1",
  continuesRunId: null,
  workspace: null,
  nudged: false,
  error: null,
  createdAt: now,
  startedAt: now,
  finishedAt: now + 1_000,
};

const primaryTask: BoardTaskDetail = {
  id: "t-primary",
  number: 1,
  title: "Studio task",
  description: "Check mentions",
  status: "in_review",
  createdBy: { kind: "agent", agentId: "a-eta" },
  assigneeAgentId: "a-eta",
  conversationId: "c-primary",
  projectId: "p-primary",
  originConversationId: "c-primary",
  workspaceMode: "local",
  workspace: { mode: "local", base: null, path: null, branch: null },
  runStatus: "completed",
  runs: [run],
  dependsOn: [],
  waitingOn: [],
  dependents: [],
  children: [],
  ancestors: [],
  artifacts: [],
  comments: 0,
  createdAt: now,
  updatedAt: now,
};

const etaProposal: CaptainOperationView = {
  id: "op-eta",
  kind: "create_agent",
  status: "pending",
  requiresApproval: true,
  actorAgentId: "captain",
  payload: {
    name: "EtaScout",
    purpose: "Review code",
    persona: "Executor",
    model: "anthropic:sonnet",
    runtime: "eta",
  },
  result: null,
  error: null,
  createdAt: now,
  updatedAt: now,
};

const extProposal: CaptainOperationView = {
  id: "op-ext",
  kind: "create_agent",
  status: "pending",
  requiresApproval: true,
  actorAgentId: "captain",
  payload: {
    name: "ExtCody",
    purpose: "Run claude",
    persona: "legacy-hidden",
    model: "claude:sonnet",
    runtime: "claude",
    machineId: "m-primary",
  },
  result: null,
  error: null,
  createdAt: now,
  updatedAt: now,
};

function Fixture() {
  const host = createHost();
  const calls = signal<string[]>([]);
  const log: string[] = [];
  const page = UrlScheme.url()?.split("/").at(-1) ?? "new-agent";
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: [
      "agents.create",
      "agents.update",
      "agents.runtimes",
      "conversations.create",
      "conversations.invite",
      "tasks.create",
      "tasks.comment",
      "places.resolve",
      "places.search",
      "places.list",
      "places.capabilities",
    ],
    targets: {
      machines: { version: 1, revisions: {}, sections: { list: machines } },
      agents: { version: 1, revisions: {}, sections: { list: agents } },
      projects: { version: 1, revisions: {}, sections: { list: projects } },
      places: {
        version: 1,
        revisions: {},
        sections: {
          recent: [
            {
              machineId: "m-primary",
              path: "/work/studio-app",
              display: "/work/studio-app",
              name: "Studio App",
              projectId: "p-primary",
            },
            {
              machineId: "m-daemon",
              path: "/work/gpu-job",
              display: "/work/gpu-job",
              name: "GPU Job",
              projectId: "p-daemon",
            },
          ],
        },
      },
      conversations: {
        version: 1,
        revisions: {},
        sections: { list: [primaryGroup] },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: { list: [primaryTask] },
      },
      "tasks.t-primary": {
        version: 1,
        revisions: {},
        sections: { task: primaryTask, activity: [] },
      },
      providers: { version: 1, revisions: {}, sections: { config: providers } },
      personas: {
        version: 1,
        revisions: {},
        sections: {
          cards: [{ id: "Executor", name: "Executor", description: "Exec" }],
        },
      },
    },
  }));
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (target === "agents" && action === "runtimes") return { runtimes } as T;
    if (target === "places" && action === "capabilities")
      return { git: true, gh: "missing" } as T;
    if (target === "places" && action === "resolve") {
      const raw = (args as { raw?: string } | undefined)?.raw ?? "";
      return { path: raw, display: raw, exists: true, directory: true } as T;
    }
    if (target === "places" && action === "search") return { matches: [] } as T;
    if (target === "places" && action === "list")
      return { path: "/", entries: [], parent: null } as T;
    log.push(`${target}.${action} ${JSON.stringify(args ?? {})}`);
    calls.set([...log]);
    if (target === "conversations" && action === "create")
      return { conversation: primaryGroup } as T;
    if (target === "tasks" && action === "create")
      return { created: [primaryTask] } as T;
    return {} as T;
  };

  return (
    <Host.Provider value={host}>
      <Page page={page} calls={calls} />
    </Host.Provider>
  );
}

function MembersHarness() {
  const dir = signal({
    machineId: "m-primary",
    path: "/work/studio-app",
    display: "Studio App",
    name: "Studio App",
    projectId: "p-primary",
  });
  const agentIds = signal<string[]>(["a-eta", "a-ext-primary"]);
  const stewardId = signal<string | null | undefined>("a-eta");
  return (
    <View style={{ gap: 8 }}>
      <Button
        label="Pick studio"
        onPress={() =>
          dir.set({
            machineId: "m-primary",
            path: "/work/studio-app",
            display: "Studio App",
            name: "Studio App",
            projectId: "p-primary",
          })
        }
      />
      <Button
        label="Pick gpu-box"
        onPress={() =>
          dir.set({
            machineId: "m-daemon",
            path: "/work/gpu-job",
            display: "GPU Job",
            name: "GPU Job",
            projectId: "p-daemon",
          })
        }
      />
      <ConversationMembers
        directory={dir()}
        machineName={dir().machineId === "m-primary" ? "studio" : "gpu-box"}
        phone={false}
        agentIds={agentIds()}
        stewardId={stewardId()}
        onToggleAgent={(id) =>
          agentIds.update((list) =>
            list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
          )
        }
        onSteward={stewardId.set}
      />
    </View>
  );
}

function Page(props: {
  page: string;
  calls: { (): string[]; set: (next: string[]) => void };
}) {
  const noop = () => {};
  const extAgent = agents[1]!;
  return (
    <View style={{ flex: 1 }}>
      <Text>{props.calls().join("\n")}</Text>
      {props.page === "new-agent" ? (
        <AgentEditor phone={false} onClose={noop} onModelServices={noop} />
      ) : props.page === "edit-eta" ? (
        <AgentEditor
          id="a-eta"
          phone={false}
          onClose={noop}
          onModelServices={noop}
        />
      ) : props.page === "edit-ext" ? (
        <AgentEditor
          id="a-ext-primary"
          phone={false}
          onClose={noop}
          onModelServices={noop}
        />
      ) : props.page === "edit-null-ext" ? (
        <AgentEditor
          id="a-ext-null"
          phone={false}
          onClose={noop}
          onModelServices={noop}
        />
      ) : props.page === "edit-ext-missing-model" ? (
        <AgentEditor
          id="a-ext-missing-model"
          phone={false}
          onClose={noop}
          onModelServices={() =>
            props.calls.set([...props.calls(), "open modelServices"])
          }
          onRuntimes={() =>
            props.calls.set([...props.calls(), "open Runtimes"])
          }
        />
      ) : props.page === "edit-eta-missing-model" ? (
        <AgentEditor
          id="a-eta-missing-model"
          phone={false}
          onClose={noop}
          onModelServices={() =>
            props.calls.set([...props.calls(), "open modelServices"])
          }
          onRuntimes={() =>
            props.calls.set([...props.calls(), "open Runtimes"])
          }
        />
      ) : props.page === "list-and-proposals" ? (
        <View style={{ gap: 16 }}>
          <AgentSetting agent={extAgent} phone onPress={noop} />
          <Proposal operation={etaProposal} />
          <Proposal operation={extProposal} />
        </View>
      ) : props.page === "conv-members" ? (
        <MembersHarness />
      ) : props.page === "new-conv" ? (
        <NewConversation layout="desktop" onClose={noop} onOpen={noop} />
      ) : props.page === "invite" ? (
        <InviteAgents
          conversationId="c-primary"
          members={[
            {
              agentId: "a-eta",
              sessionId: null,
              lastSeq: 0,
              status: "idle",
            },
          ]}
          layout="desktop"
          onClose={noop}
        />
      ) : props.page === "new-task" ? (
        <NewTask
          phone={false}
          conversation="c-primary"
          onOpen={noop}
          onClose={noop}
        />
      ) : (
        <TaskDetail
          id="t-primary"
          layout="desktop"
          onClose={noop}
          onTask={noop}
        />
      )}
    </View>
  );
}

mount(Fixture);
