import type {
  AgentCall,
  AgentMessage,
  ConversationCall,
  HelloFrame,
  MessageView,
  ProvidersView,
  SendResult,
  ServerFrame,
  SessionCall,
  SessionHistoryResult,
  SessionViewBtwThread,
  SessionViewSections,
  SessionViewSubagent,
} from "@eta/client-contracts";
import type { CallFrame, StateSnapshot } from "@eta/client-wire-proto";
import { SESSION_ACTIONS } from "@eta/client-contracts";
import { encodeFrame, stateDiff } from "@eta/client-wire-proto";

const prompt: SessionCall = {
  op: "call",
  target: "sessions",
  action: "prompt",
  args: {
    session: "s1",
    text: "hello",
    images: [{ mime: "image/png", dataBase64: "AA==" }],
  },
};
const transport: CallFrame = prompt;
JSON.stringify(transport);
const hello: HelloFrame = {
  type: "hello",
  ops: [],
  mounted: [
    {
      name: "git",
      source: "bundled",
      descriptor: { name: "git", title: "Git", slot: "panel" },
    },
  ],
  state: {},
};
const frame: ServerFrame = hello;
encodeFrame(frame);
hello.mounted[0]?.descriptor?.slot satisfies string | undefined;
SESSION_ACTIONS satisfies readonly string[];
const state = {
  sections: { core: { session: "s1", running: false } },
  revisions: { core: "1" },
};
stateDiff(undefined, state);
const btw: SessionViewBtwThread = {
  id: "t",
  kind: "tangent",
  exchanges: [],
  saveState: "not-saved",
};
const subagent: SessionViewSubagent = { id: "a", status: "done", turns: 2 };
JSON.stringify([btw, subagent]);
// @ts-expect-error Known operations keep their required payload fields.
const bad: SessionCall = {
  op: "call",
  target: "sessions",
  action: "prompt",
  args: { session: "s1" },
};
const runtime: SessionCall = {
  op: "call",
  target: "sessions",
  action: "create",
  // @ts-expect-error Runtime pools do not belong in client create requests.
  args: { subagents: { dispose() {} } },
};
const message: AgentMessage = {
  role: "toolResult",
  toolCallId: "c",
  toolName: "x",
  content: [],
  isError: false,
  timestamp: 0,
  // @ts-expect-error Tool details must be data, not callbacks.
  details: { run() {} },
};
void [bad, runtime, message];

const provider: import("@eta/client-contracts").ProviderCall = {
  op: "call",
  target: "providers",
  action: "save",
  args: {
    revision: "r1",
    provider: {
      id: "local",
      baseUrl: "http://localhost",
      models: [{ id: "model" }],
    },
  },
};
JSON.stringify(provider);

// Every session section a host sends, as the JSON it is: each must stay plain data.
const sections = {
  core: { session: "s1", cwd: "/work", running: false },
  transcript: {
    messages: [
      {
        entryId: "e1",
        seq: 1,
        at: 10,
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: "AA==", mimeType: "image/png" },
          ],
          timestamp: 10,
        },
      },
    ],
  },
  systems: {
    rows: [
      { entryId: "g", seq: 2, kind: "goal", args: {} },
      {
        entryId: "f",
        seq: 3,
        at: 11,
        kind: "run_failed",
        args: { runId: "run", error: "model_unavailable: acme/fast" },
      },
    ],
  },
  goal: {
    objective: "ship",
    status: "active",
    roundCount: 1,
    idleWithoutTools: 0,
  },
  tasks: [
    { id: "task", content: "test", status: "pending", dependsOn: ["first"] },
  ],
  sideThread: [
    {
      id: "btw",
      kind: "contextual",
      exchanges: [
        {
          question: "why",
          answer: "because",
          at: 12,
          steps: [{ tool: "read", ok: true, at: 11 }],
        },
      ],
      saveState: "queued",
      pending: { question: "next", at: 13 },
    },
  ],
  subagents: [{ id: "child", status: "running", turns: 2 }],
  ask: {
    pending: {
      questionId: "q",
      question: "which",
      options: ["a", "b"],
      multi: true,
    },
    deadline: 100,
  },
  queue: {
    items: [
      {
        entryId: "queued",
        kind: "steer",
        text: "look",
        images: [{ mime: "image/png", dataBase64: "AA==" }],
      },
    ],
  },
} satisfies Partial<SessionViewSections>;
const session: StateSnapshot = { sections, revisions: { core: "1" } };
const config: ProvidersView = {
  revision: "hash",
  providers: [
    {
      id: "local",
      kind: "openai-compatible",
      baseUrl: "http://localhost",
      hasApiKey: true,
      headers: { "User-Agent": null },
      models: [{ id: "model", input: ["text", "image"] }],
    },
  ],
};
const fullHello: HelloFrame = {
  type: "hello",
  ops: [],
  mounted: [],
  state: {
    "sessions.s1": session,
    providers: { sections: { config }, revisions: { config: "hash" } },
  },
  diagnostics: {
    stableChars: 1,
    adaptiveChars: 2,
    sections: [{ name: "system", stable: true, text: "hello" }],
  },
};
// A history page from a server that predates system rows: `systems` is optional.
const older: SessionHistoryResult = {
  session: "s1",
  rows: sections.transcript.messages,
};
encodeFrame(fullHello);
JSON.stringify(older);

// An assistant turn, a tool result and both summaries a transcript carries.
const history: AgentMessage[] = [
  {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "model",
    timestamp: 1,
    content: [
      { type: "thinking", thinking: "plan", redacted: false },
      {
        type: "toolCall",
        id: "c",
        name: "read",
        arguments: { path: "/work", options: [true, null, 2] },
      },
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      reasoning: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "deferred",
    deferred: {
      provider: "openai",
      modelId: "model",
      api: "openai-responses",
      id: "job",
      data: { poll: true },
    },
    diagnostics: [
      {
        type: "retry",
        timestamp: 1,
        error: { message: "retry", code: 429 },
        details: { attempt: 1 },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "c",
    toolName: "read",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 2,
    details: { bytes: 2 },
    addedToolNames: ["read_more"],
  },
  {
    role: "compactionSummary",
    summary: "before",
    tokensBefore: 30,
    timestamp: 3,
  },
  { role: "branchSummary", summary: "branch", fromId: null, timestamp: 4 },
];
JSON.stringify(history);

// The product's targets: a send, an agent call, a steward set to nobody, and a send's result.
const send: ConversationCall = {
  op: "call",
  target: "conversations",
  action: "send",
  requestId: "1",
  args: {
    conversationId: "c1",
    text: "@a1 hello",
    mentions: ["a1"],
    mode: "steer",
    clientId: "client-1",
  },
};
const agentCall: AgentCall = {
  op: "call",
  target: "agents",
  action: "delete",
  args: { agentId: "a1" },
};
const steward: ConversationCall = {
  op: "call",
  target: "conversations",
  action: "setSteward",
  // Null is a real answer: the group has no steward.
  args: { conversationId: "c1", agentId: null },
};
const reply: MessageView = {
  id: "m2",
  conversationId: "c1",
  seq: 2,
  kind: "message",
  author: "agent",
  agentId: "a1",
  text: "",
  thinking: "",
  status: "queued",
  revision: 1,
  mentions: [],
  rootMessageId: "m1",
  replyToId: "m1",
  data: {},
  createdAt: 2,
  updatedAt: 2,
};
const result: SendResult = {
  message: { ...reply, id: "m1", seq: 1, author: "user", agentId: null },
  replies: [reply],
  joined: [],
  nobody: false,
};
JSON.stringify([send, agentCall, steward, result]);
