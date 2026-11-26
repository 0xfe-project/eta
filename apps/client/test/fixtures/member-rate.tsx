import type {
  AgentView,
  ConversationSummary,
  GenerationRate,
  MemberStatus,
} from "@eta/client-contracts";
import { memberSnapshot } from "../../../../test/fixtures/member-context";
import { mount, Text, View } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const summary = (adaStatus: MemberStatus): ConversationSummary => ({
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "ada",
  participants: [
    { agentId: "ada", sessionId: "s-ada", lastSeq: 0, status: adaStatus },
    { agentId: "bo", sessionId: "s-bo", lastSeq: 0, status: "idle" },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
});

const agent = (id: string, name: string) => ({ id, name }) as AgentView;

const session = (id: string, rate: GenerationRate | null) => ({
  sections: {
    ...memberSnapshot(id, "acp"),
    rate,
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
      conversations: list([summary("working")]),
      agents: list([agent("ada", "Ada"), agent("bo", "Bo")]),
      "sessions.s-ada": session("s-ada", {
        tokensPerSec: 38.4,
        basis: "estimate",
      }),
      "sessions.s-bo": session("s-bo", { tokensPerSec: 52, basis: "measured" }),
      "conversations.group": {
        sections: { timeline: { messages: [], hasMore: false, held: [] } },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;
  const generationEnds = () =>
    host.state.update((s) => ({
      ...s,
      targets: {
        ...s.targets,
        "sessions.s-ada": session("s-ada", {
          tokensPerSec: 41.6,
          basis: "measured",
        }),
      },
    }));
  const generationStarts = () =>
    host.state.update((s) => ({
      ...s,
      targets: { ...s.targets, "sessions.s-ada": session("s-ada", null) },
    }));
  const firstEstimate = () =>
    host.state.update((s) => ({
      ...s,
      targets: {
        ...s.targets,
        "sessions.s-ada": session("s-ada", {
          tokensPerSec: 7.2,
          basis: "estimate",
        }),
      },
    }));
  const runEnds = () =>
    host.state.update((s) => ({
      ...s,
      targets: { ...s.targets, conversations: list([summary("idle")]) },
    }));
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View
          role="button"
          accessibilityLabel="Generation ends"
          onPress={generationEnds}
        >
          <Text>Generation ends</Text>
        </View>
        <View
          role="button"
          accessibilityLabel="Generation starts"
          onPress={generationStarts}
        >
          <Text>Generation starts</Text>
        </View>
        <View
          role="button"
          accessibilityLabel="First estimate"
          onPress={firstEstimate}
        >
          <Text>First estimate</Text>
        </View>
        <View role="button" accessibilityLabel="Run ends" onPress={runEnds}>
          <Text>Run ends</Text>
        </View>
        <Conversation
          id="group"
          layout="desktop"
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
