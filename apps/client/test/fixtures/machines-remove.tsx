import type {
  AgentView,
  ConversationSummary,
  MachineRemovePreview,
  MachineView,
  ProjectView,
  ProvidersView,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, UrlScheme, View, windowSize } from "nsh";
import { Workspace } from "../../src/app/workspace";
import { Button } from "../../src/components";
import { Settings } from "../../src/pages/settings/settings";
import { createHost, Host } from "../../src/services/host";

const now = Date.now();

const studio: MachineView = {
  id: "m-studio",
  kind: "primary",
  name: "studio",
  status: "online",
  fingerprint: null,
  home: "/Users/dev",
  os: "darwin",
  maxActiveRuns: 2,
  createdAt: now,
  lastSeenAt: now,
  version: null,
  platform: "darwin-arm64",
  install: null,
  protocol: null,
  updateError: null,
  tailnetNode: null,
  build: null,
};

const gpuBox: MachineView = {
  id: "m-gpu",
  kind: "daemon",
  name: "gpu-box",
  status: "online",
  fingerprint: "ab".repeat(32),
  home: "/home/dev",
  os: "linux",
  maxActiveRuns: 4,
  createdAt: now,
  lastSeenAt: now,
  version: "0.5.0",
  platform: "linux-x64",
  install: "service",
  protocol: 1,
  updateError: null,
  tailnetNode: null,
  build: "current",
};

const remoteProject: ProjectView = {
  id: "p-remote",
  machineId: "m-gpu",
  path: "/srv/repo",
  display: "/srv/repo",
  name: "remote-repo",
  kind: "project",
  ownerAgentId: null,
  archived: false,
  createdAt: now,
  updatedAt: now,
};

const localProject: ProjectView = {
  id: "p-local",
  machineId: "m-studio",
  path: "/Users/dev/local",
  display: "~/local",
  name: "local-repo",
  kind: "project",
  ownerAgentId: null,
  archived: false,
  createdAt: now,
  updatedAt: now,
};

const adaAgent: AgentView = {
  id: "a-ada",
  name: "Ada",
  instructions: "",
  persona: "",
  runtime: "eta",
  model: "openai:gpt-5",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  systemRole: null,
  avatarSeed: null,
  avatarSeeds: [],
  home: "/tmp/ada",
  homeProjectId: "p-ada",
  status: "idle",
  createdAt: now,
  updatedAt: now,
};

const codyAgent: AgentView = {
  ...adaAgent,
  id: "a-cody",
  name: "Cody",
  runtime: "claude",
  model: null,
  machineId: "m-gpu",
  home: "/tmp/cody",
  homeProjectId: "p-cody",
};

const pinnedEtaAgent: AgentView = {
  ...adaAgent,
  id: "a-pinned",
  name: "PinnedAda",
  machineId: "m-gpu",
  home: "/tmp/pinned",
  homeProjectId: "p-pinned",
};

const remoteConv: ConversationSummary = {
  id: "c-remote",
  projectId: "p-remote",
  kind: "group",
  name: "remote-chat",
  archived: false,
  stewardId: "a-pinned",
  participants: [],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: now,
  updatedAt: now,
};

const archivedRemoteConv: ConversationSummary = {
  ...remoteConv,
  id: "c-old",
  name: "old-chat",
  archived: true,
};

const localConv: ConversationSummary = {
  ...remoteConv,
  id: "c-local",
  projectId: "p-local",
  name: "local-chat",
  stewardId: "a-ada",
};

const emptyProviders: ProvidersView = {
  providers: [],
  revision: "1",
  privateNetwork: { allow: [], loopback: false, invalid: [] },
};

function Fixture() {
  const host = createHost();
  let machinesList = [studio, gpuBox];
  let agentsList = [adaAgent, codyAgent, pinnedEtaAgent];
  let projectsList = [remoteProject, localProject];
  let convsList = [remoteConv, archivedRemoteConv, localConv];
  const calls: { action: string; machineId: string }[] = [];

  const list = <T,>(items: T[]) => ({
    version: 1,
    revisions: {},
    sections: { list: items },
  });

  const publishAll = () => {
    host.state.update((prev) => ({
      ...prev,
      status: "open",
      ops: ["machines.removePreview", "machines.remove", "machines.rename"],
      targets: {
        ...prev.targets,
        providers: {
          version: 1,
          revisions: {},
          sections: { config: emptyProviders },
        },
        machines: list(machinesList),
        agents: list(agentsList),
        projects: list(projectsList),
        conversations: list(convsList),
        "conversations.c-remote": {
          version: 1,
          revisions: {},
          sections: {
            info: {
              id: "c-remote",
              projectId: "p-remote",
              kind: "group",
              name: "remote-chat",
              goal: "",
              decided: "",
              archived: false,
              stewardId: "a-pinned",
              readSeq: 0,
              lastSeq: 0,
              createdAt: now,
              updatedAt: now,
            },
            members: [],
            timeline: { messages: [], hasMore: false, held: [] },
          },
        },
        "conversations.c-local": {
          version: 1,
          revisions: {},
          sections: {
            info: {
              id: "c-local",
              projectId: "p-local",
              kind: "group",
              name: "local-chat",
              goal: "",
              decided: "",
              archived: false,
              stewardId: "a-ada",
              readSeq: 0,
              lastSeq: 0,
              createdAt: now,
              updatedAt: now,
            },
            members: [],
            timeline: { messages: [], hasMore: false, held: [] },
          },
        },
      },
    }));
  };

  publishAll();
  host.address.set({ origin: "http://example.invalid" });

  const applyRemove = (machineId: string) => {
    machinesList = machinesList.filter((m) => m.id !== machineId);
    agentsList = agentsList.filter((a) => a.machineId !== machineId);
    const removedProjectIds = new Set(
      projectsList.filter((p) => p.machineId === machineId).map((p) => p.id),
    );
    projectsList = projectsList.filter((p) => p.machineId !== machineId);
    convsList = convsList.filter((c) => !removedProjectIds.has(c.projectId));
    publishAll();
  };

  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (target !== "machines") return {} as T;
    const given = args as { machineId: string };
    calls.push({ action, machineId: given.machineId });
    if (action === "removePreview") {
      const preview: MachineRemovePreview = {
        machine: { id: "m-gpu", name: "gpu-box" },
        agents: [
          {
            id: codyAgent.id,
            name: codyAgent.name,
            runtime: codyAgent.runtime,
          },
          {
            id: pinnedEtaAgent.id,
            name: pinnedEtaAgent.name,
            runtime: pinnedEtaAgent.runtime,
          },
        ],
        projects: [
          {
            id: remoteProject.id,
            name: remoteProject.name,
            path: remoteProject.path,
          },
        ],
        conversations: [
          {
            id: remoteConv.id,
            name: remoteConv.name,
            projectId: remoteConv.projectId,
            archived: false,
          },
          {
            id: archivedRemoteConv.id,
            name: archivedRemoteConv.name,
            projectId: archivedRemoteConv.projectId,
            archived: true,
          },
        ],
        activeRuns: 1,
        activeReplies: 2,
      };
      return preview as T;
    }
    if (action === "remove") {
      applyRemove(given.machineId);
      return {
        machineId: given.machineId,
        removedAgents: [codyAgent.id, pinnedEtaAgent.id],
        removedProjects: [remoteProject.id],
        removedConversations: [remoteConv.id, archivedRemoteConv.id],
      } as T;
    }
    return {} as T;
  };

  const width = windowSize().width;
  const layout = (): Layout =>
    width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop";
  const mode = UrlScheme.url()?.includes("workspace")
    ? "workspace"
    : "settings";
  const noop = () => {};

  if (mode === "workspace") {
    return (
      <Host.Provider value={host}>
        <View style={{ flex: 1 }}>
          <Button
            label="Simulate machine removed"
            onPress={() => applyRemove("m-gpu")}
          />
          <Workspace
            layout={layout()}
            theme="light"
            onTheme={noop}
            paletteId="default"
            onPalette={noop}
            flavor="mocha"
            onFlavor={noop}
            chatWidth="standard"
            onChatWidth={noop}
            chatRail={false}
            onChatRail={noop}
            onFonts={noop}
            onConnect={noop}
          />
        </View>
      </Host.Provider>
    );
  }

  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Settings
          initial="Machines"
          layout={layout()}
          theme="light"
          chatWidth="standard"
          chatRail
          paletteId="default"
          flavor="mocha"
          onTheme={noop}
          onPalette={noop}
          onFlavor={noop}
          onChatWidth={noop}
          onChatRail={noop}
          onFonts={noop}
          onConnect={noop}
          onTask={noop}
          onClose={noop}
        />
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
