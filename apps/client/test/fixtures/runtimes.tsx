import type {
  AgentRuntimeAccount,
  AgentRuntimeInfo,
  AgentView,
  MachineView,
  ProviderUsage,
} from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { AgentEditor } from "../../src/pages/settings/agents/editor";
import { Settings } from "../../src/pages/settings/settings";
import { createHost, Host } from "../../src/services/host";

// Settings › Runtimes and the agent editor's Runtime field, over a scripted host. Nothing here is
// a real runtime or account: every probe answer is written below.
// - The primary "studio" has Claude Code (signed in), Codex (not signed in), OpenCode (its probe
//   timed out), Pi (not installed), Antigravity (not signed in), and an external agent whose
//   probe failed.
// - The daemon "gpu-box" is online with Claude Code and Codex; "attic" is offline.
// - `agents.runtimes { fresh: true }` answers OpenCode as available, as a retry after a slow probe.
// - `agents.runtimeAccount`: Claude Code is signed in with two plan windows, Codex is signed out.
// The address picks what is shown: `.../editor` an agent's editor, `.../new` the new-agent dialog,
// else Settings › Runtimes. Every call is listed at the top as `target.action args`, newest last.

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
  machine("m-primary", "studio", "primary", "online"),
  machine("m-gpu", "gpu-box", "daemon", "online"),
  machine("m-attic", "attic", "daemon", "offline"),
];

const sonnet = {
  id: "sonnet",
  name: "Sonnet",
  default: true,
  efforts: ["low", "medium", "high"],
};

function primary(fresh: boolean): AgentRuntimeInfo[] {
  return [
    {
      id: "claude",
      label: "Claude Code",
      status: "available",
      version: "2.1.311 (Claude Code)",
      models: [
        sonnet,
        { id: "opus", name: "Opus", default: false, efforts: [] },
      ],
    },
    {
      id: "codex",
      label: "Codex",
      status: "unauthenticated",
      version: "codex-cli 0.167.2",
      detail: "codex: not logged in (run `codex login`)",
      models: [],
    },
    fresh
      ? {
          id: "opencode",
          label: "OpenCode",
          status: "available",
          version: "1.19.5",
          models: [],
        }
      : {
          id: "opencode",
          label: "OpenCode",
          status: "error",
          detail:
            "oar: `opencode models --verbose` timed out after 30000ms\n    at listModels (oar/opencode.js:88)",
          models: [],
        },
    {
      id: "pi",
      label: "Pi",
      status: "missing",
      detail: "pi: command not found on PATH",
      models: [],
    },
    {
      id: "antigravity",
      label: "Antigravity",
      status: "unauthenticated",
      version: "1.5.16",
      detail: "Please sign in to view available models",
      models: [],
    },
    {
      id: "acp.gemini",
      label: "Gemini CLI",
      status: "error",
      detail: "spawn gemini --experimental-acp: exited with code 1",
      models: [],
    },
  ];
}

const gpu: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    version: "2.1.300",
    models: [sonnet],
  },
  {
    id: "codex",
    label: "Codex",
    status: "available",
    version: "codex-cli 0.167.2",
    models: [],
  },
];

const accounts: Record<string, AgentRuntimeAccount> = {
  claude: {
    auth: {
      kind: "logged_in",
      email: "ada@example.com",
      plan: "max",
      method: "claude.ai",
    },
    usage: {
      kind: "available",
      plan: "max",
      rateLimited: false,
      windows: [
        { label: "5h", usedRatio: 0.42 },
        { label: "7d", usedRatio: 0.18 },
      ],
    },
  },
  codex: {
    auth: { kind: "logged_out" },
    usage: { kind: "reauth_required", reason: "not_logged_in" },
  },
  antigravity: {
    auth: { kind: "logged_out" },
  },
};

const usage: ProviderUsage[] = [
  {
    provider: "claude",
    windows: {
      "5h": {
        requests: 3,
        failed: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 9000,
        cost: 0,
      },
      "24h": {
        requests: 7,
        failed: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 21000,
        cost: 0,
      },
      "7d": {
        requests: 20,
        failed: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 48213,
        cost: 0,
      },
      "30d": {
        requests: 41,
        failed: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 90000,
        cost: 0,
      },
    },
  },
];

const bo = {
  id: "a-bo",
  name: "Bo",
  instructions: "",
  persona: "",
  runtime: "codex",
  model: null,
  thinkingLevel: null,
  machineId: "m-primary",
  plugins: [],
  skippedPlugins: [],
  systemRole: null,
} as unknown as AgentView;

// An agent left on a runtime this machine does not have, so the field has to say so.
const pi = {
  ...bo,
  id: "a-pi",
  name: "Pi",
  runtime: "pi",
} as unknown as AgentView;

const agy = {
  ...bo,
  id: "a-antigravity",
  name: "Agy",
  runtime: "antigravity",
} as unknown as AgentView;

function Fixture() {
  const host = createHost();
  const calls = signal<string[]>([]);
  const log: string[] = [];
  const page = UrlScheme.url()?.split("/").at(-1);
  host.state.update((prev) => ({
    ...prev,
    status: "open",
    ops: ["agents.runtimes", "agents.runtimeAccount", "agents.update"],
    targets: {
      machines: { version: 1, revisions: {}, sections: { list: machines } },
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [bo, pi, agy] },
      },
      usage: { version: 1, revisions: {}, sections: { providers: usage } },
    },
  }));
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    // Kept outside the signal: a call made inside an effect must not make it read the log.
    log.push(`${target}.${action} ${JSON.stringify(args ?? {})}`);
    calls.set([...log]);
    const given = (args ?? {}) as {
      fresh?: boolean;
      machineId?: string;
      runtime?: string;
    };
    if (action === "runtimes")
      return {
        runtimes: given.machineId === "m-gpu" ? gpu : primary(!!given.fresh),
      } as T;
    if (action === "runtimeAccount")
      return { account: accounts[given.runtime ?? ""] ?? {} } as T;
    return {} as T;
  };
  return (
    <Host.Provider value={host}>
      <Page page={page} calls={calls} />
    </Host.Provider>
  );
}

function Page(props: {
  page: string | undefined;
  calls: { (): string[]; set: (next: string[]) => void };
}) {
  const width = windowSize().width;
  const layout = width < 600 ? "phone" : width < 1200 ? "tablet" : "desktop";
  const noop = () => {};
  const editing =
    props.page === "editor" ||
    props.page === "new" ||
    props.page === "pi" ||
    props.page === "antigravity";
  return (
    <View style={{ flex: 1 }}>
      <Text>{props.calls().join("\n")}</Text>
      {editing ? (
        <AgentEditor
          id={
            props.page === "editor"
              ? bo.id
              : props.page === "pi"
                ? pi.id
                : props.page === "antigravity"
                  ? agy.id
                  : undefined
          }
          phone={layout === "phone"}
          tablet={layout === "tablet"}
          onClose={noop}
          onModelServices={noop}
          onRuntimes={() => props.calls.set(["open Runtimes"])}
        />
      ) : (
        <Settings
          initial="Runtimes"
          layout={layout}
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
      )}
    </View>
  );
}
mount(Fixture);
