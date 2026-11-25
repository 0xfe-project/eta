// 04–07d: a machine's tree of directories, the models, and the ops that make things, answered as
// apps/eta answers them. `host.scenario` "agent-create-fails" refuses the first agents.create.

import type {
  AgentArgs,
  AgentFields,
  AgentRuntimeInfo,
  AgentView,
  CloneView,
  ConversationArgs,
  ConversationInfo,
  ConversationSummary,
  MachineView,
  PlaceListing,
  ProjectArgs,
  ProjectView,
  ProvidersView,
  RecentPlace,
  TimelineSection,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { agentOnlyChat } from "@eta/client-contracts";
import { Storage } from "nsh";
import { minutesAgo, PROJECTS } from "./base";

const HOME = "/Users/eric";

/** A directory in the tree: hidden by a dot, a repository, the project there. */
interface Dir {
  name: string;
  hidden: boolean;
  git: boolean;
  projectId: string | null;
}

const dir = (name: string, fields: Partial<Dir> = {}): Dir => ({
  name,
  hidden: name.startsWith("."),
  git: false,
  projectId: null,
  ...fields,
});

const TREE: Record<string, Dir[]> = {
  [HOME]: [
    dir(".config"),
    dir("Developer"),
    dir("Documents"),
    dir("big"),
    dir("locked"),
    dir("site", { git: true, projectId: "site" }),
  ],
  [`${HOME}/.config`]: [],
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

/** A failure as the host words one: the code in `problem`, which the client reads. */
const failure = (code: string) =>
  Object.assign(new Error(`places: ${code}`), { problem: { code } });

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const display = (path: string) =>
  path === HOME
    ? "~"
    : path.startsWith(`${HOME}/`)
      ? `~${path.slice(HOME.length)}`
      : path;
const ref = (path: string) => ({ path, display: display(path) });
const resolve = (raw: string): string => {
  const typed = raw.trim();
  const expanded =
    typed === "~" || typed.startsWith("~/")
      ? `${HOME}${typed.slice(1)}`
      : typed;
  if (!expanded.startsWith("/")) throw failure("not_absolute");
  return expanded.replace(/\/+$/, "") || "/";
};

const PROVIDERS: ProvidersView = {
  revision: "r1",
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
      project.id === "site"
        ? { ...project, path: `${HOME}/site`, display: "~/site" }
        : project,
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
            display: "~/Developer/hutch",
            archived: true,
          },
        ]),
  ]);
  if (host.scenario !== "uninitialized")
    host.set("providers", { config: PROVIDERS });
  host.set("personas", { cards: PERSONAS });
  // What a phone from before kept of recent directories: handed to the host on the next visit.
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
    stewardId: string | null = agentIds[0] ?? null,
  ): ConversationSummary => ({
    id: id("conversation"),
    projectId,
    kind,
    name,
    archived: false,
    stewardId,
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
    // An agent's home directory is a project too, though the project list does not show it.
    const home = agents().find((each) => each.homeProjectId === args.projectId);
    const project =
      projects().find((each) => each.id === args.projectId) ??
      (home && { id: home.homeProjectId, name: home.name });
    if (project === undefined) throw new Error("no such project");
    const members = args.agentIds ?? [];
    // As the host: a group needs a member, and its steward is one of them, null for none, or
    // (left out) the first.
    if (members.length === 0)
      throw new Error("a group needs at least one member");
    const stewardId =
      args.stewardId === undefined ? (members[0] ?? null) : args.stewardId;
    if (stewardId !== null && !members.includes(stewardId))
      throw new Error("the steward has to be a member");
    const given = args.name?.trim();
    // A group nobody named takes the project's name, not the names of who is in it.
    const name = given === undefined || given === "" ? project.name : given;
    // Stricter than the host, which would make a second group of the same one agent: a press that
    // makes a chat instead of finding the one the agent has is a failure here, where it is seen.
    const [only] = members;
    const known =
      members.length === 1 && only !== undefined
        ? conversations().find(
            (each) =>
              each.projectId === project.id &&
              !each.archived &&
              agentOnlyChat(each, only),
          )
        : undefined;
    if (known !== undefined) throw new Error("this agent already has its chat");
    const made = conversation(project.id, "group", name, members, stewardId);
    open(made);
    return { conversation: made };
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

  // `places.*`, answered for the tree above: mac-studio is the machine, gpu-box does not answer.
  const machineOf = (args: { machineId?: string }) => {
    const machine = host
      .section<MachineView[]>("machines", "list")
      .find((each) => each.id === (args.machineId ?? "mac-studio"));
    if (machine === undefined || machine.id === "gpu-box")
      throw failure("offline");
    return machine;
  };
  const recent = (): RecentPlace[] =>
    host.section<RecentPlace[]>("places", "recent") ?? [];
  const recentPlace = (
    machineId: string,
    path: string,
    usedAt: number,
  ): RecentPlace => ({
    machineId,
    ...ref(path),
    projectId:
      projects().find(
        (each) => each.machineId === machineId && each.path === path,
      )?.id ?? null,
    parent: path === "/" ? null : ref(parentOf(path)),
    usedAt,
  });
  host.set("places", {
    recent: projects()
      .filter((project) => !project.archived && project.kind === "project")
      .map((project, at) =>
        recentPlace(project.machineId, project.path, 100 - at),
      ),
    clones: [] as CloneView[],
  });
  host.on(
    "places.importRecent",
    ({ recent: given }: { recent: Record<string, string[]> }) => {
      let added = 0;
      const known = recent();
      const more: RecentPlace[] = [];
      for (const [machineId, paths] of Object.entries(given))
        for (const path of paths)
          if (
            !known.some(
              (each) => each.machineId === machineId && each.path === path,
            )
          ) {
            more.push(recentPlace(machineId, path, 0));
            added += 1;
          }
      host.patch("places", "recent", [...known, ...more]);
      return { added };
    },
  );
  host.on("places.remember", () => ({}));
  host.on("places.capabilities", (args: { machineId?: string }) => {
    machineOf(args);
    return {
      flavor: "posix",
      home: HOME,
      git: true,
      gh: "signed_out",
      mkdir: true,
      cloneParent: ref(`${HOME}/Developer`),
    };
  });
  host.on("places.resolve", (args: { machineId?: string; path: string }) => {
    machineOf(args);
    const path = resolve(args.path);
    const there = TREE[path] !== undefined;
    return { ...ref(path), exists: there, directory: there };
  });
  host.on("places.list", (args: { machineId?: string; path?: string }) => {
    machineOf(args);
    const path = resolve(args.path ?? "~");
    if (path === `${HOME}/locked`) throw failure("denied");
    const entries = TREE[path];
    if (entries === undefined) throw failure("not_found");
    const crumbs = [];
    for (let at = path; ; at = parentOf(at)) {
      if (at === HOME) {
        crumbs.unshift({ name: "~", path: at });
        break;
      }
      if (at === "/") {
        crumbs.unshift({ name: "/", path: at });
        break;
      }
      crumbs.unshift({ name: at.slice(at.lastIndexOf("/") + 1), path: at });
    }
    const result: PlaceListing = {
      ...ref(path),
      parent: path === "/" ? null : ref(parentOf(path)),
      crumbs,
      entries: entries.map((entry) => ({
        ...entry,
        ...ref(`${path === "/" ? "" : path}/${entry.name}`),
      })),
      truncated: path === `${HOME}/big`,
      drives: [],
    };
    return result;
  });
  host.on("places.search", (args: { machineId?: string; query: string }) => {
    machineOf(args);
    const q = args.query.trim().toLowerCase();
    // A typed path: what is in the directory it names, by the start of the last part.
    if (q.startsWith("~") || q.startsWith("/")) {
      const at = resolve(args.query);
      const parent = parentOf(at);
      const term = at.slice(at.lastIndexOf("/") + 1).toLowerCase();
      const matches = (TREE[parent] ?? [])
        .filter((entry) => entry.name.toLowerCase().startsWith(term))
        .map(({ hidden: _, ...entry }) => ({
          ...entry,
          ...ref(`${parent === "/" ? "" : parent}/${entry.name}`),
        }));
      return { query: args.query, matches, truncated: false };
    }
    const matches = Object.entries(TREE)
      .flatMap(([parent, entries]) =>
        entries.map((entry) => ({ ...entry, path: `${parent}/${entry.name}` })),
      )
      .filter((entry) => !entry.hidden && entry.name.toLowerCase().includes(q))
      .slice(0, 30)
      .map(({ hidden: _, ...entry }) => ({ ...entry, ...ref(entry.path) }));
    return { query: args.query, matches, truncated: false };
  });
  host.on(
    "places.mkdir",
    (args: { machineId?: string; parent: string; name: string }) => {
      machineOf(args);
      const parent = resolve(args.parent);
      if (TREE[parent] === undefined) throw failure("not_found");
      if (args.name.includes("/") || args.name.trim() === "")
        throw failure("invalid");
      const path = `${parent}/${args.name}`;
      if (TREE[path] !== undefined) throw failure("exists");
      TREE[parent] = [...TREE[parent]!, dir(args.name)];
      TREE[path] = [];
      return ref(path);
    },
  );
  host.on("places.repos", () => ({
    available: false,
    reason: "gh_signed_out",
  }));
  host.on(
    "places.clone",
    (args: {
      machineId?: string;
      url: string;
      parent: string;
      protocol?: string;
    }) => {
      const machine = machineOf(args);
      const name =
        args.url
          .replace(/\.git$/, "")
          .split(/[/:]/)
          .at(-1) ?? "repo";
      const parent = resolve(args.parent);
      const target = `${parent}/${name}`;
      const clone: CloneView = {
        id: id("clone"),
        machineId: machine.id,
        repo: args.url,
        target: ref(target),
        status: "running",
        progress: { phase: "Receiving objects", percent: 40 },
        failure: null,
        startedAt: Date.now(),
        endedAt: null,
      };
      host.patch("places", "clones", [clone]);
      // A moment later it is there.
      setTimeout(() => {
        TREE[parent] = [...(TREE[parent] ?? []), dir(name, { git: true })];
        TREE[target] = [];
        host.patch("places", "clones", [
          { ...clone, status: "done", progress: null, endedAt: Date.now() },
        ]);
      }, 300);
      return { clone };
    },
  );
  host.on("places.cancelClone", () => ({ cancelled: false }));

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
    const path = resolve(args.path);
    const project: ProjectView = {
      id: id("project"),
      machineId,
      path,
      display: display(path),
      name:
        args.name?.trim() || args.path.slice(args.path.lastIndexOf("/") + 1),
      kind: "project",
      ownerAgentId: null,
      archived: false,
      createdAt: minutesAgo(0),
      updatedAt: minutesAgo(0),
    };
    host.patch("projects", "list", [...projects(), project]);
    return { project, existed: false };
  });
}
