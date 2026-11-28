import type {
  AgentView,
  ConversationSummary,
  MachineView,
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectView,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, UrlScheme, View, windowSize } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const machine: MachineView = {
  id: "m-remote",
  kind: "daemon",
  name: "rivus-us",
  status: "online",
  fingerprint: null,
  home: "/home/dev",
  os: "linux",
  maxActiveRuns: 2,
  createdAt: 0,
  lastSeenAt: 0,
  version: "0.5.0",
  platform: "linux-arm64",
  install: "service",
  protocol: 1,
  updateError: null,
  tailnetNode: null,
  build: "current",
};

const project: ProjectView = {
  id: "project",
  machineId: "m-remote",
  path: "/home/dev/rivus",
  display: "~/rivus",
  name: "rivus",
  kind: "project",
  ownerAgentId: null,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
};

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Rivus chat",
  archived: false,
  stewardId: "ada",
  participants: [
    { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const directories: Record<string, ProjectDirectoryListing> = {
  "": {
    path: "",
    truncated: false,
    entries: [
      { name: "src", path: "src", kind: "directory" },
      { name: ".gitignore", path: ".gitignore", kind: "file", hidden: true },
      { name: "logo.bin", path: "logo.bin", kind: "file" },
      { name: "README.md", path: "README.md", kind: "file" },
    ],
  },
  src: {
    path: "src",
    truncated: false,
    entries: [
      { name: "app.ts", path: "src/app.ts", kind: "file" },
      { name: "huge.log", path: "src/huge.log", kind: "file" },
    ],
  },
};

const files: Record<string, ProjectFileContent> = {
  "README.md": {
    kind: "text",
    path: "README.md",
    text: "# Rivus\nWorkspace readme.\n",
    size: 26,
    truncated: false,
  },
  "src/app.ts": {
    kind: "text",
    path: "src/app.ts",
    text: "export const greeting = 'hello';\n",
    size: 33,
    truncated: false,
  },
  "src/huge.log": {
    kind: "text",
    path: "src/huge.log",
    text: "line 1\nline 2\n",
    size: 512 * 1024,
    truncated: true,
  },
  "logo.bin": {
    kind: "binary",
    path: "logo.bin",
    size: 4096,
    reason: "binary",
  },
};

function Fixture() {
  const scenario = UrlScheme.url()?.split("/").pop() ?? "default";
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  host.state.update((s) => ({
    ...s,
    status: "open",
    ops:
      scenario === "legacy"
        ? ["projects.files"]
        : ["projects.files", "projects.directory", "projects.readFile"],
    targets: {
      ...s.targets,
      machines: list([machine]),
      projects: list([project]),
      conversations: list([summary]),
      agents: list([{ id: "ada", name: "Ada" } as AgentView]),
      artifacts: list([]),
      tasks: list([]),
      "conversations.group": {
        sections: { timeline: { messages: [], hasMore: false, held: [] } },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    if (target === "projects" && action === "directory") {
      const path = ((args as { path?: string } | undefined)?.path ?? "").trim();
      const hit = directories[path];
      if (!hit) throw new Error(`no such directory: ${path}`);
      return hit as T;
    }
    if (target === "projects" && action === "readFile") {
      const path = (args as { path: string }).path;
      const hit = files[path];
      if (!hit) throw new Error(`no such file: ${path}`);
      return hit as T;
    }
    return undefined as T;
  };
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Conversation
          id="group"
          layout={layout()}
          onTask={noop}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
