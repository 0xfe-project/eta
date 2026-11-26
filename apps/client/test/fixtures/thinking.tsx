import type {
  AgentRuntimeInfo,
  AgentView,
  MachineView,
  ProvidersView,
} from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View } from "nsh";
import { AgentEditor } from "../../src/pages/settings/agents/editor";
import { createHost, Host } from "../../src/services/host";

// The agent editor's thinking level over a scripted host whose models declare their levels the
// way an endpoint's /models does (#799):
// - proxy:flash declares high and max; proxy:hy declares none and high (an off switch);
//   proxy:plain says it does not reason; proxy:thinks reasons at levels it does not name;
//   proxy:silent says nothing.
// - Claude Code on the primary lists sonnet with low, medium, high and ultra, and opus with none.
// The address is `eta://fixture/<agent id>`: the editor of that agent. Every update is listed at
// the top as `agents.update args`, newest last.

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
];

const providers = {
  providers: [
    {
      id: "proxy",
      name: "Proxy",
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:3425/v1",
      hasApiKey: true,
      models: [
        {
          id: "flash",
          name: "Flash",
          reasoning: true,
          reasoningEfforts: ["high", "max"],
        },
        {
          id: "hy",
          name: "Hy",
          reasoning: true,
          reasoningEfforts: ["high"],
          thinkingMode: "both",
        },
        { id: "plain", name: "Plain", reasoning: false },
        { id: "thinks", name: "Thinks", reasoning: true },
        { id: "silent", name: "Silent" },
      ],
    },
  ],
} as unknown as ProvidersView;

const runtimes: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    models: [
      {
        id: "sonnet",
        name: "Sonnet",
        default: true,
        efforts: ["low", "medium", "high", "ultra"],
      },
      { id: "opus", name: "Opus", default: false, efforts: [] },
    ],
  },
];

const agent = (
  id: string,
  runtime: string,
  model: string | null,
  thinkingLevel: string | null,
): AgentView =>
  ({
    id,
    name: id,
    instructions: "",
    persona: "",
    runtime,
    model,
    thinkingLevel,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
  }) as unknown as AgentView;

const agents = [
  agent("flash", "eta", "proxy:flash", null),
  agent("hy", "eta", "proxy:hy", "high"),
  agent("plain", "eta", "proxy:plain", null),
  agent("thinks", "eta", "proxy:thinks", null),
  agent("silent", "eta", "proxy:silent", null),
  /** Saved before levels were checked: `ultra` on a model that declares high and max. */
  agent("stale", "eta", "proxy:flash", "ultra"),
  {
    ...agent("cody", "claude", "claude:sonnet", "ultra"),
    machineId: "m-primary",
  },
];

function Fixture() {
  const host = createHost();
  const calls = signal<string[]>([]);
  const log: string[] = [];
  const id = UrlScheme.url()?.split("/").at(-1) ?? "flash";
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: ["agents.runtimes", "agents.update"],
    targets: {
      machines: { version: 1, revisions: {}, sections: { list: machines } },
      agents: { version: 1, revisions: {}, sections: { list: agents } },
      providers: { version: 1, revisions: {}, sections: { config: providers } },
    },
  }));
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (action === "runtimes") return { runtimes } as T;
    log.push(`${target}.${action} ${JSON.stringify(args ?? {})}`);
    calls.set([...log]);
    return { agent: agents.find((each) => each.id === id) } as T;
  };
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{calls().join("\n")}</Text>
        <AgentEditor
          id={id}
          phone={false}
          onClose={noop}
          onModelServices={noop}
        />
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
