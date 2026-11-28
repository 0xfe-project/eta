import type {
  AgentRuntimeInfo,
  AgentView,
  PluginView,
} from "@eta/client-contracts";
import { mount, signal, Storage, Text, View } from "nsh";
import { Button } from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { openAgentChat } from "../../src/pages/templates/agent-chat";
import { TemplateGallery } from "../../src/pages/templates/gallery";
import { createHost, Host } from "../../src/services/host";

const readyPlugin: PluginView = {
  name: "slack-tools",
  version: "1.0.0",
  description: "Slack tools",
  source: { kind: "local", path: "/plugins/slack-tools" },
  enabled: true,
  state: "ready",
  problem: null,
  reports: [],
  skills: [],
  servers: [],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  agents: [],
};

const unconfiguredPlugin: PluginView = {
  name: "github-tools",
  version: "1.0.0",
  description: "GitHub tools",
  source: { kind: "local", path: "/plugins/github-tools" },
  enabled: true,
  state: "needs_config",
  problem: null,
  reports: [],
  skills: [],
  servers: [
    {
      name: "gh",
      transport: "stdio",
      command: ["gh-mcp"],
      env: [],
      missingEnv: ["GITHUB_TOKEN"],
      headers: [],
      plainHttp: false,
      problem: null,
    },
  ],
  requires: [],
  machines: [],
  fields: [],
  headers: [],
  env: [],
  agents: [],
};

const externalRuntimes: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    models: [
      { id: "sonnet", name: "Sonnet", default: true, efforts: ["low", "high"] },
    ],
  },
];

// The template gallery over a host with one model, `source:model`. Storage `phone` opens the
// phone layout, `initial` the template a link named, `models` "0" takes the models away,
// `create` "fail" makes the host refuse the agent, `chat` "fail" refuses the chat made for it,
// `plugins` "1" populates installed plugins, `external` "1" advertises Claude Code, and `existing`
// seeds an existing agent of that name.
function Fixture(props: {
  phone: boolean;
  initial?: string;
  models: boolean;
  fail: boolean;
  chatFail: boolean;
  plugins: boolean;
  external: boolean;
  existing?: string;
}) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const created = signal("");
  const opened = signal("");
  const marketOpened = signal(false);
  const activeInitial = signal<string | undefined>(props.initial);
  const existingAgents: AgentView[] = props.existing
    ? [
        {
          id: "existing-1",
          name: props.existing,
          instructions: "",
          persona: "",
          runtime: "eta",
          model: "source:model",
          thinkingLevel: null,
          machineId: null,
          plugins: [],
          skippedPlugins: [],
          systemRole: null,
          avatarSeed: null,
          avatarSeeds: [],
          home: "/agents/existing-1",
          homeProjectId: "home-existing-1",
          status: "idle",
          createdAt: 1,
          updatedAt: 1,
        },
      ]
    : [];
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: props.external ? ["agents.runtimes"] : [],
    targets: {
      ...state.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: { list: existingAgents },
      },
      plugins: {
        version: 1,
        revisions: {},
        sections: {
          list: props.plugins ? [readyPlugin, unconfiguredPlugin] : [],
          audit: [],
        },
      },
      providers: {
        version: 1,
        revisions: {},
        sections: {
          config: {
            revision: "r1",
            providers: [
              {
                id: "source",
                kind: "deepseek",
                name: "Source",
                baseUrl: "https://api.deepseek.com",
                hasApiKey: true,
                models: props.models ? [{ id: "model" }] : [],
              },
            ],
          },
        },
      },
    },
  }));
  host.call = (async (target: string, action: string, args: unknown) => {
    if (target === "plugins" && action === "composioPlugins")
      return { plugins: [] };
    if (target === "agents" && action === "runtimes")
      return { runtimes: props.external ? externalRuntimes : [] };
    sent.set([...sent(), `${target}.${action} ${JSON.stringify(args)}`]);
    if (target === "agents" && action === "create") {
      if (props.fail) throw new Error("name taken");
      const name =
        typeof (args as { name?: unknown })?.name === "string"
          ? (args as { name: string }).name
          : "Agent";
      const agent: AgentView = {
        id: "new-agent",
        name,
        instructions: "",
        persona: "",
        runtime: "eta",
        model: "source:model",
        thinkingLevel: null,
        machineId: null,
        plugins: [],
        skippedPlugins: [],
        systemRole: null,
        avatarSeed: null,
        avatarSeeds: [],
        home: "/agents/new-agent",
        homeProjectId: "home-new-agent",
        status: "idle",
        createdAt: 1,
        updatedAt: 1,
      };
      return { agent };
    }
    if (target === "conversations" && action === "create") {
      if (props.chatFail) throw new Error("no such project");
      return { conversation: { id: "new-conversation" } };
    }
    return {};
  }) as typeof host.call;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(" | ")}`}</Text>
        <Text>{`Created: ${created()}`}</Text>
        <Text>{`Opened: ${opened()}`}</Text>
        <Text>{`Market: ${marketOpened() ? "open" : "closed"}`}</Text>
        <Button
          label="Switch link"
          onPress={() => activeInitial.set("pr-reviewer")}
        />
        <TemplateGallery
          phone={props.phone}
          initialId={activeInitial()}
          onClose={noop}
          onCreated={(agent) => {
            created.set(`${agent.id}@${agent.homeProjectId}`);
            void openAgentChat(host, agent).then((id) => opened.set(id ?? ""));
          }}
          onModelServices={noop}
          onOpenMarket={() => marketOpened.set(true)}
        />
        <NotificationHost />
      </View>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("phone"),
  Storage.getItem("initial"),
  Storage.getItem("models"),
  Storage.getItem("create"),
  Storage.getItem("chat"),
  Storage.getItem("plugins"),
  Storage.getItem("external"),
  Storage.getItem("existing"),
]).then(([phone, initial, models, create, chat, plugins, external, existing]) =>
  mount(() => (
    <Fixture
      phone={phone === "1"}
      initial={initial || undefined}
      models={models !== "0"}
      fail={create === "fail"}
      chatFail={chat === "fail"}
      plugins={plugins === "1"}
      external={external === "1"}
      existing={existing || undefined}
    />
  )),
);
