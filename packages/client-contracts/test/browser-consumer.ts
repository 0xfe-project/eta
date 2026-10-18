import {
  stateSection,
  SESSION_ACTIONS,
  type HelloFrame,
  type ServerFrame,
  type SessionCall,
  type SessionViewBtwThread,
  type SessionViewSubagent,
  type AgentMessage,
} from "@eta/client-contracts";
import { encodeFrame, stateDiff, type CallFrame } from "@eta/client-wire-proto";

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
stateSection(state, "core")?.session satisfies string | undefined;
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
