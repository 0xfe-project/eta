import type { AgentView, ConversationSummary } from "@eta/client-contracts";
import {
  memberReadings,
  memberSnapshot,
  type Replay,
} from "../../../../test/fixtures/member-context";
import type { Layout } from "../../src/components";
import { mount, Text, View, windowSize } from "nsh";
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

const session = (id: string, replay: Replay) => ({
  sections: {
    ...memberSnapshot(id, replay),
    tools: [],
    model: { id: "fake:m", thinkingLevel: "off" },
  },
  revisions: {},
  version: 0,
});

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
      "sessions.s-ada": session("s-ada", "acp"),
      "sessions.s-bo": session("s-bo", "codex"),
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
  let step = 0;
  const replays = Object.keys(memberReadings) as Replay[];
  function advance() {
    const replay = replays[++step % replays.length]!;
    host.state.update((s) => ({
      ...s,
      targets: { ...s.targets, "sessions.s-ada": session("s-ada", replay) },
    }));
  }
  function replaceSession() {
    const participants = summary.participants.map((member) =>
      member.agentId === "ada"
        ? { ...member, sessionId: "s-replacement" }
        : member,
    );
    host.state.update((s) => ({
      ...s,
      targets: {
        ...s.targets,
        conversations: list([{ ...summary, participants }]),
      },
    }));
  }
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View role="button" accessibilityLabel="Next reading" onPress={advance}>
          <Text>Next reading</Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Replace session"
          onPress={replaceSession}
        >
          <Text>Replace session</Text>
        </View>
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
