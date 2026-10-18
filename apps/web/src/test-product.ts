// The product's targets for component tests: fixtures for what the host publishes (agents,
// machines, projects, conversations and their messages) and a fake host that has the four plugins
// mounted and their lists as its first state. Tests add the calls they expect with
// `host.handle("conversations.send", ...)` and a conversation's own target with `conversation()`.

import type {
  AgentView,
  ConversationInfo,
  ConversationSummary,
  MachineView,
  MemberView,
  MessageView,
  ProjectView,
} from "@eta/client-contracts";
import { FakeHost } from "@/test-wire";

export const agentView = (
  fields: Partial<AgentView> & { id: string },
): AgentView => ({
  name: fields.id,
  instructions: "",
  persona: "",
  model: "p:m",
  thinkingLevel: null,
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
  createdAt: 1,
  lastSeenAt: null,
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

/** The sections of `conversations.<id>`, from a summary and the rows. */
export function conversationSections(
  summary: ConversationSummary,
  messages: MessageView[] = [],
  extra: Partial<ConversationInfo> = {},
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
    timeline: { messages, hasMore: false },
  };
}

export interface ProductSeed {
  agents?: AgentView[];
  machines?: MachineView[];
  projects?: ProjectView[];
  conversations?: ConversationSummary[];
  /** The rows of each conversation, by its id; a conversation target is made for each. */
  messages?: Record<string, MessageView[]>;
}

/**
 * A host with the four product plugins mounted and their lists as the first state, installed as
 * the page's connection and connected. Each seeded conversation also gets its own target.
 */
export function productHost(seed: ProductSeed = {}): FakeHost {
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
      ["agents", "machines", "projects", "conversations"].map((name) => ({
        name,
        source: "bundled" as const,
      })),
    );
  for (const summary of seed.conversations ?? []) {
    host.target(
      `conversations.${summary.id}`,
      conversationSections(summary, seed.messages?.[summary.id]),
    );
  }
  host.install();
  host.hello();
  return host;
}
