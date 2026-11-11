// 04–07d: a machine's tree of directories, the models, and the ops that make things, answered as
// apps/eta answers them. `host.scenario` "agent-create-fails" refuses the first agents.create.

import type {
  AgentArgs,
  AgentFields,
  AgentRuntimeInfo,
  AgentView,
  ConversationArgs,
  ConversationInfo,
  ConversationSummary,
  DirectoryEntry,
  MachineView,
  ProjectArgs,
  ProjectResults,
  ProjectView,
  ProvidersView,
  TimelineSection,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { Storage } from "nsh";
import { minutesAgo, PROJECTS } from "./base";

const HOME = "/Users/eric";

const dir = (
  name: string,
  fields: Partial<DirectoryEntry> = {},
): DirectoryEntry => ({
  name,
  hidden: name.startsWith("."),
  git: false,
  projectId: null,
  ...fields,
});

const TREE: Record<string, DirectoryEntry[]> = {
  [HOME]: [
    dir(".config"),
    dir("Developer"),
    dir("Documents"),
    dir("big"),
    dir("locked"),
    dir("site", { git: true, projectId: "site" }),
  ],
  [`${HOME}/Developer`]: [
    dir("eta", { git: true, projectId: "eta" }),
    dir("hutch", { git: true, projectId: "hutch" }),
    dir("notes"),
  ],
  [`${HOME}/Developer/eta`]: [
    dir("apps"),
    dir("docs"),
    dir("packages"),
    dir("scripts"),
  ],
  [`${HOME}/Developer/notes`]: [],
  [`${HOME}/Documents`]: [],
  [`${HOME}/big`]: Array.from({ length: 1000 }, (_, at) => dir(`dir-${at}`)),
};

const failure = (code: "not_found" | "denied" | "offline") =>
  new Error(`directory: ${code}`);

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

const PROVIDERS: ProvidersView = {
  revision: "r1",
  defaultModel: "codex:gpt-5.1-codex",
  providers: [
    {
      id: "codex",
      kind: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      hasApiKey: false,
      models: [{ id: "gpt-5.1-codex" }, { id: "gpt-5.1" }],
    },
    {
      id: "kimi",
      kind: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      hasApiKey: false,
      models: [{ id: "kimi-k2" }],
    },
  ],
};

const RUNTIMES: AgentRuntimeInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    status: "available",
    models: [{ id: "opus", name: "Opus", default: true, efforts: [] }],
  },
  { id: "codex", label: "Codex", status: "missing", models: [] },
];

const PERSONAS = [
  {
    id: "engineer",
    name: "Engineer",
    description: "Write and modify code",
    custom: false,
  },
  {
    id: "designer",
    name: "Designer",
    description: "Build UI and interactions",
    custom: false,
  },
];

export function installCreate(host: FakeHost): void {
  const conversations = () =>
    host.section<ConversationSummary[]>("conversations", "list");
  const projects = () => host.section<ProjectView[]>("projects", "list");
  const agents = () => host.section<AgentView[]>("agents", "list");
  let made = 0;
  const id = (kind: string) => `${kind}-${++made}`;

  // The design's website lives at ~/site. `hutch` was added and put away: 07a's already added.
  const site = PROJECTS.find((project) => project.id === "site");
  host.patch("projects", "list", [
    ...projects().map((project) =>
      project.id === "site" ? { ...project, path: `${HOME}/site` } : project,
    ),
    ...(site === undefined
      ? []
      : [
          {
            ...site,
            id: "hutch",
            name: "hutch",
            machineId: "mac-studio",
            path: `${HOME}/Developer/hutch`,
            archived: true,
          },
        ]),
  ]);
  if (host.scenario !== "uninitialized")
    host.set("providers", { config: PROVIDERS });
  host.set("personas", { cards: PERSONAS });
  void Storage.getItem("eta.recentDirectories").then((stored) => {
    if (stored === null || stored === undefined)
      void Storage.setItem(
        "eta.recentDirectories",
        JSON.stringify({ "mac-studio": [`${HOME}/Developer/hutch`] }),
      );
  });

  const open = (conversation: ConversationSummary): void => {
    host.patch("conversations", "list", [conversation, ...conversations()]);
    const info: ConversationInfo = {
      id: conversation.id,
      projectId: conversation.projectId,
      kind: conversation.kind,
      name: conversation.name,
      goal: "",
      decided: "",
      archived: false,
      stewardId: conversation.stewardId,
      stewardOverrideId: null,
      noSteward: false,
      readSeq: 0,
      lastSeq: 0,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
    const timeline: TimelineSection = {
      messages: [],
      hasMore: false,
      held: [],
    };
    host.set(`conversations.${conversation.id}`, { info, timeline });
  };

  const conversation = (
    projectId: string,
    kind: ConversationSummary["kind"],
    name: string,
    agentIds: string[],
  ): ConversationSummary => ({
    id: id("conversation"),
    projectId,
    kind,
    name,
    archived: false,
    stewardId: agentIds[0] ?? null,
    participants: agentIds.map((agentId) => ({
      agentId,
      sessionId: null,
      lastSeq: 0,
      status: "idle",
    })),
    lastSeq: 0,
    readSeq: 0,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  host.on("conversations.create", (args: ConversationArgs["create"]) => {
    const project = projects().find((each) => each.id === args.projectId);
    if (project === undefined) throw new Error("no such project");
    const members = args.agentIds ?? [];
    const given = args.name?.trim();
    // A group nobody named takes the project's name, not the names of who is in it.
    const name = given === undefined || given === "" ? project.name : given;
    const made = conversation(project.id, "group", name, members);
    open(made);
    return { conversation: made };
  });

  host.on("agents.direct", ({ agentId }: AgentArgs["direct"]) => {
    const agent = agents().find((each) => each.id === agentId);
    if (agent === undefined) throw new Error("no such agent");
    const found = conversations().find(
      (each) =>
        each.kind === "direct" && each.participants[0]?.agentId === agentId,
    );
    if (found === undefined) {
      const made = conversation(agent.homeProjectId, "direct", agent.name, [
        agentId,
      ]);
      open(made);
      return { conversation: made };
    }
    if (!found.archived) return { conversation: found };
    const back = { ...found, archived: false };
    host.patch(
      "conversations",
      "list",
      conversations().map((each) => (each.id === found.id ? back : each)),
    );
    return { conversation: back };
  });

  let refused = host.scenario !== "agent-create-fails";
  host.on("agents.create", (fields: AgentFields) => {
    if (!refused) {
      refused = true;
      throw new Error("model unavailable");
    }
    const name = fields.name.trim();
    if (name === "") throw new Error("an agent needs a name");
    const agentId = id("agent");
    const agent: AgentView = {
      id: agentId,
      name,
      instructions: fields.instructions ?? "",
      persona: fields.persona ?? "",
      runtime: fields.runtime ?? "eta",
      model: fields.model ?? null,
      thinkingLevel: fields.thinkingLevel ?? null,
      machineId: fields.machineId ?? null,
      plugins: fields.plugins ?? [],
      skippedPlugins: [],
      home: `${HOME}/.eta/agents/${agentId}`,
      homeProjectId: `home-${agentId}`,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    host.patch("agents", "list", [...agents(), agent]);
    return { agent };
  });

  host.on("agents.runtimes", ({ machineId }: AgentArgs["runtimes"]) => {
    if (machineId === undefined || machineId === "mac-studio")
      return { runtimes: RUNTIMES };
    // A daemon that has its own: Claude Code only on the primary.
    return {
      runtimes: RUNTIMES.map((runtime) =>
        runtime.id === "claude"
          ? { ...runtime, status: "missing", models: [] }
          : runtime,
      ),
    };
  });

  host.on("projects.directories", (args: ProjectArgs["directories"]) => {
    const machine = host
      .section<MachineView[]>("machines", "list")
      .find((each) => each.id === (args.machineId ?? "mac-studio"));
    if (machine === undefined || machine.id === "gpu-box")
      throw failure("offline");
    const raw = args.path ?? HOME;
    const path = raw === "~" ? HOME : raw.replace(/\/+$/, "") || "/";
    if (path === `${HOME}/locked`) throw failure("denied");
    const entries = TREE[path];
    if (entries === undefined) throw failure("not_found");
    const result: ProjectResults["directories"] = {
      path,
      home: HOME,
      parent: path === "/" ? null : parentOf(path),
      entries,
      truncated: path === `${HOME}/big`,
    };
    return result;
  });

  host.on("projects.create", (args: ProjectArgs["create"]) => {
    const machineId = args.machineId ?? "mac-studio";
    if (!args.path.startsWith("/"))
      throw new Error(`the path must be absolute: ${args.path}`);
    const found = projects().find(
      (each) => each.machineId === machineId && each.path === args.path,
    );
    if (found !== undefined) {
      const back = { ...found, archived: false };
      host.patch(
        "projects",
        "list",
        projects().map((each) => (each.id === found.id ? back : each)),
      );
      return { project: back, existed: true };
    }
    const project: ProjectView = {
      id: id("project"),
      machineId,
      path: args.path,
      name:
        args.name?.trim() || args.path.slice(args.path.lastIndexOf("/") + 1),
      kind: "project",
      stewardId: args.stewardId ?? null,
      archived: false,
      createdAt: minutesAgo(0),
      updatedAt: minutesAgo(0),
    };
    host.patch("projects", "list", [...projects(), project]);
    return { project, existed: false };
  });
}
