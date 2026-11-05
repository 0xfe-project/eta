// 03j–03o, 03h2: the facts, sessions and artifacts of the design's groups, and the ops that change
// them. Other fixtures may already hold the same conversation targets (the timeline is chat's), so
// this one adds to what is there. The board's tasks and `tasks.link` are `tasks.ts`'s.

import type {
  AgentView,
  ArtifactVersionView,
  ArtifactView,
  ConversationInfo,
  ConversationSummary,
  MessageView,
  ProjectView,
  RoutineSummary,
  TimelineSection,
} from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";
import { effect, Storage, untracked } from "nsh";
import { agents } from "../../app/lists";
import { phase, wire } from "../../app/session";
import { go } from "../../nav/links";
import { minutesAgo } from "./base";

/** `eta.fake.route` (`group:wire`, `agent:agent-xiaoman`, `artifact:reconnect`) starts on that screen. */
const ROUTE_KEY = "eta.fake.route";

async function followRoute(): Promise<void> {
  const route = await Storage.getItem(ROUTE_KEY);
  if (route === null || route === undefined) return;
  const [screen = "", id = ""] = route.split(":");
  let done = false;
  effect(() => {
    if (phase() !== "ready" || wire().lastSeenAt() === undefined || agents().length === 0) return;
    if (untracked(() => done)) return;
    done = true;
    if (screen === "group") go.groupInfo(id);
    if (screen === "agent") go.agentInfo(id);
    if (screen === "artifact") go.artifact(id);
  });
}

const SHARE_TOKEN = "7f3a91c2";

const GOALS: Record<string, { goal: string; decided: string }> = {
  wire: {
    goal: "断线重连后不丢帧、不重复，迁移能回滚。",
    decided: "客户端带 last_seq，host 从那一行往后重放。",
  },
};

const version = (number: number, fields: Partial<ArtifactVersionView> = {}): ArtifactVersionView => ({
  number,
  kind: "site",
  viewer: "iframe",
  files: 6,
  bytes: 48_210,
  size: 12_044,
  createdAt: minutesAgo(600 - number * 100),
  archiveUrl: `/artifacts/reconnect/${number}/archive.zip`,
  shareUrl: null,
  sharedAt: null,
  ...fields,
});

const ARTIFACTS: ArtifactView[] = [
  {
    id: "reconnect",
    title: "重连方案",
    publisherAgentId: "agent-ache",
    taskId: "task-128",
    conversationId: "wire",
    versions: [version(2), version(1)],
    createdAt: minutesAgo(500),
    updatedAt: minutesAgo(400),
  },
  {
    id: "scripts",
    title: "迁移脚本",
    publisherAgentId: "agent-mori",
    taskId: null,
    conversationId: "board",
    versions: [version(1, { kind: "bundle", viewer: "download", archiveUrl: "/artifacts/scripts/1/archive.zip" })],
    createdAt: minutesAgo(800),
    updatedAt: minutesAgo(800),
  },
];

const ROUTINES = [
  {
    id: "weekly",
    name: "每周汇总",
    conversationId: "artifacts",
    nextRunAt: minutesAgo(-2000),
    runs: [],
  } as unknown as RoutineSummary,
];

const usage = (input: number, output: number, cache: number) => ({
  input,
  output,
  cacheRead: cache,
  cacheWrite: 0,
  totalTokens: input + output + cache,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const tools = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ name: `tool-${index}`, description: "" }));

/** The page 03n draws. The real host answers `/preview/<capability>/…`; here nothing could serve it. */
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="margin:0;padding:24px 20px;font:14px/22px system-ui;color:#737373;background:#fafafa">
<h1 style="margin:0 0 12px;font:400 24px/24px system-ui;color:#0a0a0a">重连补帧方案</h1>
<p style="margin:0 0 12px">客户端保存最后收到的 seq，重连时带给 host。host 从下一行开始重放，再切回实时帧。</p>
<div style="height:180px;background:#f5f5f5;margin:0 0 12px"></div>
<p style="margin:0">200 次强杀重连，没有丢帧，也没有重复帧。</p>`;

const reply = (id: string, conversationId: string, agentId: string, status: MessageView["status"], text: string): MessageView => ({
  id,
  conversationId,
  seq: 12,
  kind: "message",
  author: "agent",
  agentId,
  text,
  thinking: "",
  status,
  revision: 1,
  mentions: [],
  rootMessageId: null,
  replyToId: null,
  data: {},
  createdAt: minutesAgo(2),
  updatedAt: minutesAgo(1),
});

const replies: Record<string, MessageView[]> = {
  wire: [reply("wire-ache", "wire", "agent-ache", "waiting_for_input", "迁移会锁 message 表大约 40 秒，得你定。")],
  board: [reply("board-mori", "board", "agent-mori", "working", "列宽放进 localStorage，换设备不跟着走。")],
};

function list(host: FakeHost): ConversationSummary[] {
  return host.section<ConversationSummary[]>("conversations", "list") ?? [];
}

function info(host: FakeHost, id: string): ConversationInfo | undefined {
  return host.section<ConversationInfo | undefined>(`conversations.${id}`, "info");
}

function findProject(host: FakeHost, id: string): ProjectView | undefined {
  return host.section<ProjectView[]>("projects", "list").find((project) => project.id === id);
}

/** What the list and the conversation's target both say, kept the same, as `summary` does on the host. */
function change(
  host: FakeHost,
  id: string,
  summary: Partial<ConversationSummary>,
  own: Partial<ConversationInfo> = {},
): ConversationSummary {
  const next = list(host).map((row) => (row.id === id ? { ...row, ...summary } : row));
  host.patch("conversations", "list", next);
  const current = info(host, id);
  const rest = Object.fromEntries(
    Object.entries(summary).filter(([key]) => key === "name" || key === "archived" || key === "stewardId"),
  );
  if (current !== undefined) host.patch(`conversations.${id}`, "info", { ...current, ...rest, ...own });
  const row = next.find((conversation) => conversation.id === id);
  if (row === undefined) throw new Error(`unknown conversation: ${id}`);
  return row;
}

function existing(host: FakeHost, id: string): ConversationSummary {
  const row = list(host).find((conversation) => conversation.id === id);
  if (row === undefined) throw new Error(`unknown conversation: ${id}`);
  return row;
}

function installConversationOps(host: FakeHost): void {
  host.on("conversations.update", ({ conversationId, name, goal, decided, archived }) => {
    const trimmed = (name as string | undefined)?.trim();
    if (trimmed === "") throw new Error("a conversation needs a name");
    const own: Partial<ConversationInfo> = {};
    if (goal !== undefined) own.goal = goal;
    if (decided !== undefined) own.decided = decided;
    const summary: Partial<ConversationSummary> = {};
    if (trimmed !== undefined) summary.name = trimmed;
    if (archived !== undefined) summary.archived = archived;
    return { conversation: change(host, conversationId, summary, own) };
  });

  host.on("conversations.invite", ({ conversationId, agentId }) => {
    const row = existing(host, conversationId);
    if (row.kind === "direct") throw new Error("a private chat is the agent and the user");
    const participants = row.participants.some((member) => member.agentId === agentId)
      ? row.participants
      : [...row.participants, { agentId, sessionId: null, lastSeq: 0, status: "idle" as const }];
    return { conversation: change(host, conversationId, { participants }) };
  });

  host.on("conversations.remove", ({ conversationId, agentId }) => {
    const row = existing(host, conversationId);
    if (row.kind === "direct") throw new Error("a private chat is the agent and the user");
    const participants = row.participants.filter((member) => member.agentId !== agentId);
    const own = info(host, conversationId);
    if (own?.stewardOverrideId === agentId) {
      const stewardId = findProject(host, row.projectId)?.stewardId ?? null;
      return { conversation: change(host, conversationId, { participants, stewardId }, { stewardOverrideId: null }) };
    }
    return { conversation: change(host, conversationId, { participants }) };
  });

  host.on("conversations.setSteward", ({ conversationId, agentId, none }) => {
    const row = existing(host, conversationId);
    const noSteward = agentId === null && none === true;
    const stewardId = noSteward
      ? null
      : (agentId ?? findProject(host, row.projectId)?.stewardId ?? null);
    return {
      conversation: change(host, conversationId, { stewardId }, { stewardOverrideId: agentId, noSteward }),
    };
  });

  if (!host.ops.has("conversations.stop")) {
    host.on("conversations.stop", ({ conversationId, messageId }) => {
      const timeline = host.section<TimelineSection>(`conversations.${conversationId}`, "timeline");
      const stopped: MessageView[] = [];
      const messages = timeline.messages.map((message) => {
        if (message.id !== messageId) return message;
        const next = { ...message, status: "stopped" as const };
        stopped.push(next);
        return next;
      });
      host.patch(`conversations.${conversationId}`, "timeline", { ...timeline, messages });
      return { stopped };
    });
  }

  if (!host.ops.has("conversations.history")) {
    host.on("conversations.history", ({ conversationId }) => ({ conversationId, messages: [], hasMore: false }));
  }

  host.on("projects.setSteward", ({ projectId, agentId }) => {
    const projects = host.section<ProjectView[]>("projects", "list");
    host.patch(
      "projects",
      "list",
      projects.map((project) => (project.id === projectId ? { ...project, stewardId: agentId } : project)),
    );
    for (const row of list(host)) {
      const follows = (info(host, row.id)?.stewardOverrideId ?? null) === null;
      if (row.projectId === projectId && row.kind === "group" && follows) change(host, row.id, { stewardId: agentId });
    }
    return { project: findProject(host, projectId) };
  });

  if (!host.ops.has("agents.direct")) {
    host.on("agents.direct", ({ agentId }) => {
      const conversation = list(host).find(
        (row) => row.kind === "direct" && row.participants[0]?.agentId === agentId,
      );
      if (conversation !== undefined) return { conversation };
      const name = host.section<AgentView[]>("agents", "list").find((agent) => agent.id === agentId)?.name ?? "";
      const made: ConversationSummary = {
        ...existing(host, "dm-xiaoman"),
        id: `dm-${agentId}`,
        projectId: `home-${agentId}`,
        name,
        participants: [{ agentId, sessionId: null, lastSeq: 0, status: "idle" }],
      };
      host.patch("conversations", "list", [...list(host), made]);
      return { conversation: made };
    });
  }
}

function installArtifactOps(host: FakeHost): void {
  const edit = (artifactId: string, number: number, fields: Partial<ArtifactVersionView>): ArtifactView => {
    const artifacts = host.section<ArtifactView[]>("artifacts", "list");
    const next = artifacts.map((artifact) =>
      artifact.id !== artifactId
        ? artifact
        : {
            ...artifact,
            versions: artifact.versions.map((item) => (item.number === number ? { ...item, ...fields } : item)),
          },
    );
    host.patch("artifacts", "list", next);
    const changed = next.find((artifact) => artifact.id === artifactId);
    if (changed === undefined) throw new Error(`unknown artifact: ${artifactId}`);
    return changed;
  };

  host.on("artifacts.share", ({ artifactId, version: number }) => {
    const url = `/share/${SHARE_TOKEN}/`;
    return { artifact: edit(artifactId, number, { shareUrl: url, sharedAt: Date.now() }), url };
  });
  host.on("artifacts.unshare", ({ artifactId, version: number }) => ({
    artifact: edit(artifactId, number, { shareUrl: null, sharedAt: null }),
  }));
  let refuse = host.scenario === "preview-refused";
  host.on("artifacts.preview", ({ version: number }) => {
    if (refuse) {
      refuse = false;
      throw new Error("preview is not available");
    }
    return {
      // "relative-urls" answers exactly as apps/eta does, for what is built on the address.
      url:
        host.scenario === "relative-urls"
          ? `/preview/${number}.9999.sig/index.html`
          : `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`,
      expiresAt: Date.now() + 3_600_000,
    };
  });
}

function installSessions(host: FakeHost): void {
  host.set("sessions.session-agent-ache", {
    model: { id: "claude-opus-5-5", thinkingLevel: "high" },
    usage: usage(48_200, 6_100, 210_000),
    metrics: { tokensPerSec: 42 },
    tools: tools(23),
    tasks: [],
  });
  host.set("sessions.session-agent-mori", {
    model: { id: "claude-opus-5-5", thinkingLevel: "high" },
    usage: usage(12_400, 1_800, 40_000),
    metrics: { tokensPerSec: 0 },
    tools: tools(18),
    tasks: [
      { id: "step-1", content: "量一下现在的列宽", status: "completed" },
      { id: "step-2", content: "把列宽写进设置", status: "in_progress" },
    ],
  });
  host.set("sessions.session-agent-xiaoman", {
    model: { id: "gpt-5.1-codex", thinkingLevel: "medium" },
    usage: usage(3_200, 640, 0),
    metrics: { tokensPerSec: 0 },
    tools: tools(12),
    tasks: [],
  });
  host.on("sessions.resync", () => ({}));
  host.on("sessions.taskUpdate", ({ session, id, status }) => {
    const target = `sessions.${session}`;
    const tasks = host.section<{ id: string }[]>(target, "tasks");
    host.patch(target, "tasks", tasks.map((item) => (item.id === id ? { ...item, status } : item)));
    return {};
  });
}

export function installGroup(host: FakeHost): void {
  // 03j draws Mori before its first wake, and 03h2 draws 小满 as the design has it.
  host.patch(
    "conversations",
    "list",
    list(host).map((row) =>
      row.id !== "wire"
        ? row
        : {
            ...row,
            participants: row.participants.map((member) =>
              member.agentId === "agent-mori" ? { ...member, sessionId: null } : member,
            ),
          },
    ),
  );
  host.patch(
    "agents",
    "list",
    host.section<AgentView[]>("agents", "list").map((agent) =>
      agent.id !== "agent-xiaoman"
        ? agent
        : {
            ...agent,
            status: "working" as const,
            machineId: "mac-studio",
            model: "openai-codex:gpt-5.1-codex",
            thinkingLevel: null,
            persona: "",
            instructions: "你负责每周把任务汇总成周报，只写做完的和受阻的，下周计划单列一节。",
          },
    ),
  );

  for (const row of list(host)) {
    const target = `conversations.${row.id}`;
    const sections = host.state.get(target) ?? {};
    const held = sections.info as ConversationInfo | undefined;
    const facts: ConversationInfo = {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      name: row.name,
      goal: GOALS[row.id]?.goal ?? "",
      decided: GOALS[row.id]?.decided ?? "",
      archived: row.archived,
      stewardId: row.stewardId,
      stewardOverrideId: held?.stewardOverrideId ?? null,
      noSteward: held?.noSteward ?? false,
      readSeq: row.readSeq,
      lastSeq: row.lastSeq,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    const timeline: TimelineSection = { messages: replies[row.id] ?? [], hasMore: false, held: [] };
    host.set(target, {
      members: row.participants,
      timeline,
      ...sections,
      info: { ...facts, ...held, goal: facts.goal || (held?.goal ?? ""), decided: facts.decided || (held?.decided ?? "") },
    });
  }

  host.set("artifacts", { list: ARTIFACTS });
  host.set("routines", { list: ROUTINES }, { eager: true });
  installConversationOps(host);
  installArtifactOps(host);
  installSessions(host);
  void followRoute();
}
