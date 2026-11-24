import type {
  AgentView,
  CaptainIdentitySection,
  ConversationSummary,
} from "@eta/client-contracts";
import { mount, View } from "nsh";
import { Button } from "../../src/components";
import { CaptainCard } from "../../src/navigation/captain";
import { createHost, Host } from "../../src/services/host";

/** 2026-01-02 10:00 local: an old date, so the card spells the day out. */
const at = new Date(2026, 0, 2, 10, 0).getTime();

const row = (
  id: string,
  kind: ConversationSummary["kind"],
  lastMessageAt: number | null,
): ConversationSummary => ({
  id,
  projectId: "project",
  kind,
  name: kind === "captain" ? "Captain" : "Website",
  archived: false,
  stewardId: kind === "captain" ? "captain" : "ada",
  participants: [
    {
      agentId: kind === "captain" ? "captain" : "ada",
      sessionId: null,
      lastSeq: 0,
      status: "idle",
    },
  ],
  lastSeq: lastMessageAt === null ? 0 : 2,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt,
  createdAt: 0,
  updatedAt: 0,
});

const identity = (
  lastMessageAt: number | null,
): { sections: { identity: CaptainIdentitySection } } => ({
  sections: {
    identity: {
      agentId: "captain",
      name: "Captain",
      home: "/home/captain",
      model: "fake:model",
      conversationId: "captain-chat",
      createdAt: 0,
      conversation: row("captain-chat", "captain", lastMessageAt),
    },
  },
});

/**
 * The Captain card on a host like a real one: Captain's conversation is not in the conversation
 * list (only a group with a recent message is), it comes with Captain's identity. "Captain
 * answers" is a message in Captain's conversation.
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
      conversations: list([row("group", "group", Date.now())]),
      agents: list([
        { id: "captain", name: "Captain", systemRole: "captain" } as AgentView,
        { id: "ada", name: "Ada" } as AgentView,
      ]),
      captain: { ...identity(null), revisions: {}, version: 0 },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>() => undefined as T;
  const answer = () =>
    host.state.update((s) => ({
      ...s,
      targets: {
        ...s.targets,
        captain: { ...identity(at), revisions: {}, version: 1 },
      },
    }));
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, width: 320 }}>
        <Button label="Captain answers" onPress={answer} />
        <CaptainCard onPress={() => {}} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
