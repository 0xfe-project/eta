import type { ConversationSummary } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { ChatList } from "../../src/navigation/chat-list";
import { createHost, Host } from "../../src/services/host";

// The desktop sidebar's groups on a Host that answers `conversations.update` as the real one does:
// a new name is refused while another live group of the project has it.

const now = Date.now();
const group = (
  id: string,
  name: string,
  projectId = "p-site",
): ConversationSummary => ({
  id,
  projectId,
  kind: "group",
  name,
  archived: false,
  stewardId: null,
  participants: [],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: now,
  updatedAt: now,
});

function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  const groups = () => host.conversations();
  const set = (next: ConversationSummary[]) =>
    host.state.update((state) => ({
      ...state,
      targets: { ...state.targets, conversations: list(next) },
    }));
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["conversations.update"],
    targets: { ...state.targets, agents: list([]), projects: list([]) },
  }));
  set([
    group("launch", "Launch"),
    group("pricing", "Pricing page"),
    group("docs", "Docs", "p-docs"),
  ]);
  host.call = (async (
    target: string,
    action: string,
    args: { conversationId: string; name?: string; archived?: boolean },
  ) => {
    if (target !== "conversations" || action !== "update") return {};
    const current = groups().find((item) => item.id === args.conversationId)!;
    const name = args.name?.trim();
    if (
      name !== undefined &&
      groups().some(
        (item) =>
          item.id !== current.id &&
          item.projectId === current.projectId &&
          !item.archived &&
          item.name === name,
      )
    )
      throw new Error(`a group named "${name}" already exists in this project`);
    const next = {
      ...current,
      name: name ?? current.name,
      archived: args.archived ?? current.archived,
    };
    set(groups().map((item) => (item.id === current.id ? next : item)));
    return { conversation: next };
  }) as typeof host.call;
  const selected = signal("launch");
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1, width: 320 }}>
        <ChatList
          layout="desktop"
          selected={selected()}
          onConversation={selected.set}
          onCreate={noop}
          onArchived={noop}
        />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
