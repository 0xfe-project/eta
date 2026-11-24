import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, View, windowSize } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

/**
 * Group "Website redesign", one member per state of a member's Inspect:
 * - Ada (eta): a session with a two-block prompt, two tools and a finished run;
 * - Cody (Claude Code): a session whose view carries eta's side of the prompt and tools;
 * - Dana (eta): a session the host cannot open (`target:missing`);
 * - Eve (eta): a session whose view has no `prompt` and no `tools` yet;
 * - Fay (eta): a session whose view has not arrived (its `resync` never answers).
 */
const participant = (agentId: string) => ({
  agentId,
  sessionId: `s-${agentId}`,
  lastSeq: 0,
  status: "idle" as const,
});

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "ada",
  participants: ["ada", "cody", "dana", "eve", "fay"].map(participant),
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const agent = (id: string, name: string, runtime = "eta") =>
  ({ id, name, runtime }) as AgentView;

const state = (sections: Record<string, unknown>) => ({
  sections,
  revisions: {},
  version: 0,
});

const transcript = {
  messages: [
    {
      entryId: "e1",
      seq: 1,
      at: 1,
      message: { role: "user", content: "check the OG image" },
    },
    {
      entryId: "e2",
      seq: 2,
      at: 2,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "The OG image is 1200×630." }],
      },
    },
  ],
};

const prompt = {
  stableChars: 30,
  adaptiveChars: 12,
  sections: [
    { name: "base", stable: true, text: "You are Ada, a careful helper." },
    { name: "memory", stable: false, text: "Prefers short." },
  ],
};

const tools = [
  {
    name: "esmrun",
    description:
      "Run JavaScript in this session's realm.\nThe last expression is the result.",
  },
  { name: "mention", description: "Say something to other members." },
];

function Fixture() {
  const host = createHost();
  host.state.update((s) => ({
    ...s,
    status: "open",
    missing: { ...s.missing, "sessions.s-dana": true },
    targets: {
      ...s.targets,
      conversations: state({ list: [summary] }),
      agents: state({
        list: [
          agent("ada", "Ada"),
          agent("cody", "Cody", "claude"),
          agent("dana", "Dana"),
          agent("eve", "Eve"),
          agent("fay", "Fay"),
        ],
      }),
      "sessions.s-ada": state({
        transcript,
        prompt,
        tools,
        model: { id: "fake:fake-model", thinkingLevel: "off" },
      }),
      "sessions.s-cody": state({ transcript, prompt, tools }),
      "sessions.s-eve": state({ transcript: { messages: [] } }),
      "conversations.group": state({
        timeline: { messages: [], hasMore: false, held: [] },
      }),
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = (async (_target: string, action: string, args: unknown) => {
    const session = (args as { session?: string } | undefined)?.session;
    if (action === "resync" && session === "s-fay")
      return new Promise(() => {});
    if (action === "resync" && session === "s-dana")
      throw new Error("no such session: s-dana");
    return undefined;
  }) as typeof host.call;
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
