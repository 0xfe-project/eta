// The product's targets for component tests: fixtures for what the host publishes (agents,
// machines, projects, conversations and their messages, the task board, artifacts and routines)
// and a fake host that has the plugins mounted and their lists as its first state. Tests add the
// calls they expect with `host.handle("conversations.send", ...)`.

import type {
  AgentView,
  ArtifactView,
  BoardTaskDetail,
  ConversationInfo,
  ConversationSummary,
  MachineView,
  MemberView,
  MessageView,
  ProjectView,
  RoutineInfo,
  RoutineSections,
  RoutineSummary,
  TaskActivityView,
} from "@eta/client-contracts";
import { FakeHost } from "@/test-wire";

export const agentView = (
  fields: Partial<AgentView> & { id: string },
): AgentView => ({
  name: fields.id,
  instructions: "",
  persona: "",
  runtime: "eta",
  model: "p:m",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  home: `/data/agents/${fields.id}`,
  homeProjectId: `home-${fields.id}`,
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

export const machineView = (
  fields: Partial<MachineView> & { id: string },
): MachineView => ({
  kind: "primary",
  name: fields.id,
  status: "online",
  fingerprint: null,
  home: "/home/me",
  os: "linux",
  maxActiveRuns: 2,
  createdAt: 1,
  lastSeenAt: null,
  version: null,
  platform: null,
  install: null,
  protocol: null,
  updateError: null,
  tailnetNode: null,
  build: null,
  ...fields,
});

export const projectView = (
  fields: Partial<ProjectView> & { id: string },
): ProjectView => ({
  machineId: "m1",
  path: `/work/${fields.id}`,
  name: fields.id,
  kind: "project",
  stewardId: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

export const memberView = (
  agentId: string,
  fields: Partial<MemberView> = {},
): MemberView => ({
  agentId,
  sessionId: null,
  lastSeq: 0,
  status: "idle",
  ...fields,
});

export const conversationView = (
  fields: Partial<ConversationSummary> & { id: string },
): ConversationSummary => ({
  projectId: "p1",
  kind: "group",
  name: fields.id,
  archived: false,
  stewardId: null,
  participants: [],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});

let sequence = 0;
export const messageView = (
  fields: Partial<MessageView> & { conversationId: string },
): MessageView => {
  sequence += 1;
  return {
    id: `msg-${sequence}`,
    seq: sequence,
    kind: "message",
    author: "user",
    agentId: null,
    text: "",
    thinking: "",
    status: "done",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: {},
    createdAt: sequence * 1000,
    updatedAt: sequence * 1000,
    ...fields,
  };
};

export const taskDetail = (
  fields: Partial<BoardTaskDetail> & { id: string },
): BoardTaskDetail => ({
  number: 1,
  title: fields.id,
  status: "todo",
  createdBy: { kind: "user", agentId: null },
  assigneeAgentId: null,
  conversationId: null,
  runStatus: null,
  comments: 0,
  createdAt: 1000,
  updatedAt: 1000,
  description: "",
  artifacts: [],
  projectId: null,
  workspace: { mode: "local", base: null, path: null, branch: null },
  originConversationId: null,
  runs: [],
  ...fields,
});

export const taskActivity = (
  fields: Partial<TaskActivityView> & { id: string },
): TaskActivityView => ({
  kind: "comment",
  runId: null,
  actor: { kind: "user", agentId: null },
  body: null,
  data: {},
  createdAt: 1000,
  ...fields,
});

export const artifactView = (
  fields: Partial<ArtifactView> & { id: string },
): ArtifactView => ({
  title: fields.id,
  publisherAgentId: null,
  taskId: null,
  conversationId: null,
  versions: [
    {
      number: 1,
      kind: "site",
      viewer: "iframe",
      files: 1,
      bytes: 10,
      size: 10,
      createdAt: 1000,
      archiveUrl: `/artifacts/${fields.id}/1/archive.zip`,
      shareUrl: null,
      sharedAt: null,
    },
  ],
  createdAt: 1000,
  updatedAt: 1000,
  ...fields,
});

export const routineInfo = (
  fields: Partial<RoutineInfo> & { id: string },
): RoutineInfo => ({
  name: fields.id,
  conversationId: null,
  model: null,
  schedule: { kind: "daily", time: "08:00" },
  timezone: "Asia/Shanghai",
  enabled: true,
  nextRunAt: null,
  revising: false,
  unseenReports: 0,
  unseenFailures: 0,
  createdAt: 1000,
  updatedAt: 1000,
  ...fields,
});

/** The sections of `routines.<id>`; its row in the list is `routineSummary` of the same info. */
export const routineSections = (
  info: RoutineInfo,
  rest: Partial<Omit<RoutineSections, "info">> = {},
): RoutineSections => ({
  info,
  briefs: [{ version: 1, text: "说点什么", createdAt: 1000, feedback: null }],
  runs: [],
  handoff: null,
  ...rest,
});

const routineSummary = (
  info: RoutineInfo,
  runs: RoutineSummary["runs"] = [],
): RoutineSummary => ({ ...info, runs });

/** The sections of `conversations.<id>`, from a summary and the rows. */
export function conversationSections(
  summary: ConversationSummary,
  messages: MessageView[] = [],
  extra: Partial<ConversationInfo> = {},
  held: MessageView[] = [],
) {
  const info: ConversationInfo = {
    id: summary.id,
    projectId: summary.projectId,
    kind: summary.kind,
    name: summary.name,
    goal: "",
    decided: "",
    archived: summary.archived,
    stewardId: summary.stewardId,
    stewardOverrideId: null,
    readSeq: summary.readSeq,
    lastSeq: summary.lastSeq,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...extra,
  };
  return {
    info,
    members: summary.participants,
    timeline: { messages, hasMore: false, held },
  };
}

export interface ProductSeed {
  agents?: AgentView[];
  machines?: MachineView[];
  projects?: ProjectView[];
  conversations?: ConversationSummary[];
  /** The rows of each conversation, by its id; a conversation target is made for each. */
  messages?: Record<string, MessageView[]>;
  /** The rows still waiting for a lane, by conversation; the composer shows these, not the transcript. */
  held?: Record<string, MessageView[]>;
  /** The board; a `tasks.<id>` target is made for each, with its activity. */
  tasks?: { task: BoardTaskDetail; activity?: TaskActivityView[] }[];
  artifacts?: ArtifactView[];
  /** Each routine's sections; the list is made from them. A `routines.<id>` target for each. */
  routines?: RoutineSections[];
  /** Plugins the host does not have: no target and no mount, so reading them fails. */
  absent?: ("tasks" | "artifacts" | "routines")[];
}

/** A task as the board lists it: the detail without what only its own page needs. */
function listedTask(task: BoardTaskDetail) {
  const { description: _description, artifacts: _artifacts, ...listed } = task;
  return listed;
}

/**
 * A host with the product plugins mounted and their lists as the first state, installed as
 * the page's connection and connected. Each seeded conversation also gets its own target.
 */
export function productHost(seed: ProductSeed = {}): FakeHost {
  const host = buildProductHost(seed);
  host.install();
  host.hello();
  return host;
}

/** The same host, not yet connected, with `plugins` mounted beside the product's. */
export function buildProductHost(
  seed: ProductSeed = {},
  plugins: string[] = [],
): FakeHost {
  const host = new FakeHost()
    .target("agents", { list: seed.agents ?? [] }, { eager: true })
    .target("machines", { list: seed.machines ?? [] }, { eager: true })
    .target("projects", { list: seed.projects ?? [] }, { eager: true })
    .target(
      "conversations",
      { list: seed.conversations ?? [] },
      { eager: true },
    )
    .plugins(
      [
        "agents",
        "machines",
        "projects",
        "conversations",
        "tasks",
        "artifacts",
        "routines",
        ...plugins,
      ]
        .filter(
          (name) => !(seed.absent as string[] | undefined)?.includes(name),
        )
        .map((name) => ({ name, source: "bundled" as const })),
    );
  const present = (name: "tasks" | "artifacts" | "routines") =>
    !seed.absent?.includes(name);
  if (present("tasks"))
    host.target(
      "tasks",
      { list: (seed.tasks ?? []).map(({ task }) => listedTask(task)) },
      { eager: true },
    );
  if (present("artifacts"))
    host.target("artifacts", { list: seed.artifacts ?? [] });
  if (present("routines"))
    host.target(
      "routines",
      {
        list: (seed.routines ?? []).map((sections) =>
          routineSummary(sections.info, sections.runs),
        ),
      },
      { eager: true },
    );
  for (const { task, activity } of seed.tasks ?? [])
    host.target(`tasks.${task.id}`, { task, activity: activity ?? [] });
  for (const sections of seed.routines ?? [])
    host.target(`routines.${sections.info.id}`, { ...sections });
  for (const summary of seed.conversations ?? []) {
    host.target(
      `conversations.${summary.id}`,
      conversationSections(
        summary,
        seed.messages?.[summary.id],
        {},
        seed.held?.[summary.id],
      ),
    );
  }
  return host;
}
