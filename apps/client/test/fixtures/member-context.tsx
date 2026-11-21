import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, View, windowSize } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "ada",
  participants: [
    { agentId: "ada", sessionId: "s-ada", lastSeq: 0, status: "idle" },
    { agentId: "bo", sessionId: "s-bo", lastSeq: 0, status: "idle" },
    { agentId: "cy", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const agent = (id: string, name: string) => ({ id, name }) as AgentView;

const x = (n: number) => "x".repeat(n);
let seq = 0;
const row = (message: object) => {
  seq += 1;
  return { entryId: `e${seq}`, seq, at: seq, message };
};
const user = (n: number) => row({ role: "user", content: x(n) });
const reply = (n: number) =>
  row({ role: "assistant", content: [{ type: "text", text: x(n) }] });

/**
 * A session with a 20,000-character prompt (5,000 tokens) and one tool whose name and description
 * come to 4,000 characters (1,000 tokens), on a model with no published window (128k).
 */
const session = (messages: object[]) => ({
  sections: {
    transcript: { messages },
    prompt: { sections: [], stableChars: 20_000, adaptiveChars: 20_000 },
    tools: [{ name: "esmrun", description: x(3994) }],
    model: { id: "fake:fake-model", thinkingLevel: "off" },
    usage: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 },
  },
  revisions: {},
  version: 0,
});

/**
 * Group "Website redesign": Ada has 4,000 characters from the user and 40,000 in replies (17,000
 * tokens in all, 13%); Bo had 400,000 characters of replies before a 2,000-character compaction
 * summary and 400 from the user after it (6,600 tokens, 5%); Cyrus has no session yet.
 */
function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  host.state.update((s) => ({
    ...s,
    status: "open",
    targets: {
      ...s.targets,
      conversations: list([summary]),
      agents: list([
        agent("ada", "Ada"),
        agent("bo", "Bo"),
        agent("cy", "Cyrus"),
      ]),
      "sessions.s-ada": session([user(4000), reply(40_000)]),
      "sessions.s-bo": session([
        user(400),
        reply(400_000),
        row({
          role: "compactionSummary",
          summary: x(2000),
          tokensBefore: 100_000,
          timestamp: 1,
        }),
        user(400),
      ]),
      "conversations.group": {
        sections: { timeline: { messages: [], hasMore: false, held: [] } },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;
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
