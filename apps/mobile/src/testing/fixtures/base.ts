// The cast of the design: three agents, three machines, two projects.

import type { AgentView, ConversationSummary, MachineView, MemberView, ProjectView } from "@eta/client-contracts";
import type { FakeHost } from "../fake-host";

const now = Date.now();
export const minutesAgo = (minutes: number) => now - minutes * 60_000;

const agent = (id: string, name: string, status: AgentView["status"], persona: string): AgentView => ({
  id,
  name,
  instructions: "",
  persona,
  runtime: "eta",
  model: "anthropic:claude-opus-5-5",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  home: `/Users/eric/.eta/agents/${id}`,
  homeProjectId: `home-${id}`,
  status,
  createdAt: minutesAgo(90_000),
  updatedAt: minutesAgo(30),
});

export const AGENTS: AgentView[] = [
  agent("agent-ache", "阿澈", "waiting_for_input", "engineer"),
  agent("agent-mori", "Mori", "working", "designer"),
  agent("agent-xiaoman", "小满", "idle", "assistant"),
];

const machine = (
  id: string,
  name: string,
  kind: MachineView["kind"],
  status: MachineView["status"],
): MachineView => ({
  id,
  kind,
  name,
  status,
  fingerprint: kind === "primary" ? null : "9f:3a:c1:77",
  home: "/Users/eric",
  os: "macOS 26",
  maxActiveRuns: 4,
  createdAt: minutesAgo(200_000),
  lastSeenAt: minutesAgo(1),
  version: kind === "primary" ? null : "0.8.2",
  platform: "darwin-arm64",
  install: kind === "primary" ? null : "service",
  protocol: 1,
  updateError: null,
  tailnetNode: kind === "primary" ? null : `${id}.tail3f2a.ts.net`,
  build: kind === "primary" ? null : "current",
});

export const MACHINES: MachineView[] = [
  machine("mac-studio", "mac-studio", "primary", "online"),
  machine("mb-air", "mb-air", "daemon", "online"),
  machine("nas", "nas", "ssh", "online"),
];

const project = (id: string, name: string, machineId: string, stewardId: string): ProjectView => ({
  id,
  machineId,
  path: `/Users/eric/Developer/${id}`,
  name,
  kind: "project",
  stewardId,
  archived: false,
  createdAt: minutesAgo(90_000),
  updatedAt: minutesAgo(60),
});

export const PROJECTS: ProjectView[] = [
  project("eta", "eta", "mac-studio", "agent-ache"),
  project("site", "官网", "mb-air", "agent-mori"),
];

const member = (agentId: string, status: MemberView["status"]): MemberView => ({
  agentId,
  sessionId: `session-${agentId}`,
  lastSeq: 10,
  status,
});

const conversation = (
  id: string,
  name: string,
  projectId: string,
  kind: ConversationSummary["kind"],
  participants: MemberView[],
  fields: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id,
  projectId,
  kind,
  name,
  archived: false,
  stewardId: participants[0]?.agentId ?? null,
  participants,
  lastSeq: 10,
  readSeq: 10,
  unread: 0,
  preview: "",
  lastMessageAt: minutesAgo(3),
  createdAt: minutesAgo(9000),
  updatedAt: minutesAgo(3),
  ...fields,
});

export const CONVERSATIONS: ConversationSummary[] = [
  conversation("wire", "wire 重连", "eta", "group", [member("agent-ache", "waiting_for_input"), member("agent-mori", "queued")], {
    unread: 2,
    lastSeq: 12,
    lastMessageAt: minutesAgo(0),
    preview: "迁移会锁 message 表大约 40 秒，得你定。",
  }),
  conversation("board", "任务看板改版", "eta", "group", [member("agent-mori", "working")]),
  conversation("artifacts", "产物版本", "eta", "group", [member("agent-ache", "idle"), member("agent-xiaoman", "idle")], {
    preview: "site 走 SPA 回退，版本里带上 manifest。",
    lastMessageAt: minutesAgo(1500),
  }),
  conversation("redesign", "官网改版", "site", "group", [member("agent-mori", "waiting_for_input"), member("agent-xiaoman", "idle")]),
  conversation("dm-xiaoman", "小满", "home-agent-xiaoman", "direct", [member("agent-xiaoman", "waiting_for_input")], {
    preview: "周报发给谁？",
    lastMessageAt: minutesAgo(1),
  }),
];

/** Everything the app reads from `hello`. An "uninitialized" host has no agents yet. */
export function installBase(host: FakeHost): void {
  const bare = host.scenario === "uninitialized";
  host.set("agents", { list: bare ? [] : AGENTS }, { eager: true });
  host.set("machines", { list: MACHINES, installs: [] }, { eager: true });
  host.set("projects", { list: PROJECTS }, { eager: true });
  host.set("conversations", { list: bare ? [] : CONVERSATIONS }, { eager: true });
  host.set("tasks", { list: [] }, { eager: true });
  host.set("inbox", { list: [], approvals: { tools: [] } }, { eager: true });
}
