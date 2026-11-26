import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpMachineList,
  AgentView,
  MachineView,
} from "@eta/client-contracts";
import { mount, View, windowSize } from "nsh";
import { Settings } from "../../src/pages/settings/settings";
import { createHost, Host } from "../../src/services/host";

// Settings › External agents over a scripted host, which keeps each machine's acp.json in memory
// and answers `acp.save` / `acp.test` / `acp.delete` the way the real one does:
// - "studio" (the primary) has Fake Agent (`fake`); "gpu-box" (online) has Claude Code
//   (`claude`); "attic" is offline, and the host still has the list it read from it before.
// - `save` without `previousId` refuses an id the machine already has; with one it replaces that
//   agent (a rename when the ids differ). A machine that is not online refuses every call.
// - `test` answers for the command `fake-acp`, and says `gemini` is not installed.

const now = Date.now();

const machine = (
  id: string,
  name: string,
  kind: MachineView["kind"],
  status: MachineView["status"],
): MachineView => ({
  id,
  name,
  kind,
  status,
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
});

const machines = [
  machine("m-studio", "studio", "primary", "online"),
  machine("m-gpu", "gpu-box", "daemon", "online"),
  machine("m-attic", "attic", "daemon", "offline"),
];

const view = (config: AcpAgentConfig): AcpAgentView => ({
  ...config,
  runtime: `acp.${config.id}`,
  status: "available",
});

function Fixture() {
  const host = createHost();
  const files: Record<string, AcpAgentConfig[]> = {
    "m-studio": [
      {
        id: "fake",
        label: "Fake Agent",
        command: "fake-acp",
        args: ["--acp"],
        env: {},
      },
    ],
    "m-gpu": [
      {
        id: "claude",
        label: "Claude Code",
        command: "claude-acp",
        args: [],
        env: {},
      },
    ],
    "m-attic": [
      {
        id: "goose",
        label: "Goose",
        command: "goose",
        args: ["acp"],
        env: {},
      },
    ],
  };
  let etaAgents: AgentView[] = [
    {
      id: "a-cody",
      name: "Cody",
      instructions: "",
      persona: "",
      runtime: "acp.claude",
      model: null,
      thinkingLevel: null,
      machineId: "m-gpu",
      plugins: [],
      skippedPlugins: [],
      systemRole: null,
      avatarSeed: null,
      avatarSeeds: [],
      home: "/tmp/a-cody",
      homeProjectId: "p-cody",
      status: "working",
      createdAt: now,
      updatedAt: now,
    },
  ];
  const lists = (): Record<string, AcpMachineList> =>
    Object.fromEntries(
      Object.entries(files).map(([id, agents]) => [
        id,
        { agents: agents.map(view) },
      ]),
    );
  const publishAgents = () =>
    host.state.update((prev) => ({
      ...prev,
      targets: {
        ...prev.targets,
        agents: { version: 1, revisions: {}, sections: { list: etaAgents } },
      },
    }));
  const publish = () =>
    host.state.update((prev) => ({
      ...prev,
      targets: {
        ...prev.targets,
        acp: { version: 1, revisions: {}, sections: { machines: lists() } },
      },
    }));
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: [
      "acp.refresh",
      "acp.save",
      "acp.test",
      "acp.deletePreview",
      "acp.delete",
    ],
    targets: {
      machines: { version: 1, revisions: {}, sections: { list: machines } },
      agents: { version: 1, revisions: {}, sections: { list: etaAgents } },
    },
  }));
  publish();
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (target !== "acp") return {} as T;
    const given = args as {
      machineId: string;
      agent?: AcpAgentConfig;
      previousId?: string;
      id?: string;
      deleteAgents?: boolean;
    };
    const where = machines.find((item) => item.id === given.machineId);
    if (where?.status !== "online")
      throw new Error(`${where?.name ?? given.machineId} is offline`);
    const agents = files[given.machineId] ?? [];
    if (action === "refresh") return lists()[given.machineId] as T;
    if (action === "test")
      return (
        given.agent?.command === "fake-acp"
          ? {
              ok: true,
              status: "available",
              agentName: "Fake Agent",
              version: "0.0.1",
            }
          : {
              ok: false,
              status: "missing",
              detail: `${given.agent?.command} is not installed`,
            }
      ) as T;
    if (action === "deletePreview") {
      const runtime = `acp.${given.id}`;
      const dependents = etaAgents
        .filter(
          (item) =>
            item.runtime === runtime && item.machineId === given.machineId,
        )
        .map((item) => ({
          id: item.id,
          name: item.name,
          runtime,
          groupCount: 1,
          busy: item.status !== "idle",
        }));
      return {
        id: given.id ?? "",
        machineId: given.machineId,
        agents: dependents,
      } as T;
    }
    if (action === "delete") {
      const runtime = `acp.${given.id}`;
      const dependents = etaAgents.filter(
        (item) =>
          item.runtime === runtime && item.machineId === given.machineId,
      );
      if (dependents.length > 0 && given.deleteAgents !== true) {
        throw new Error(
          `Cannot delete ${given.id}: ${dependents.map((d) => d.name).join(", ")} runs on ${runtime}`,
        );
      }
      files[given.machineId] = agents.filter((item) => item.id !== given.id);
      if (dependents.length > 0) {
        const gone = new Set(dependents.map((d) => d.id));
        etaAgents = etaAgents.filter((item) => !gone.has(item.id));
        publishAgents();
      }
      publish();
      return (
        dependents.length > 0
          ? { deletedAgents: dependents.map((d) => d.id) }
          : {}
      ) as T;
    }
    if (action === "save" && given.agent) {
      const agent = given.agent;
      const others = agents.filter((item) => item.id !== given.previousId);
      if (others.some((item) => item.id === agent.id))
        throw new Error(
          `An external agent with the id ${agent.id} already exists on ${where.name}`,
        );
      const at = agents.findIndex((item) => item.id === given.previousId);
      files[given.machineId] =
        at === -1
          ? [...agents, agent]
          : agents.map((item, index) => (index === at ? agent : item));
      publish();
      return view(agent) as T;
    }
    return {} as T;
  };
  const width = windowSize().width;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Settings
          initial="External agents"
          layout={width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop"}
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
