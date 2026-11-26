import type {
  ConversationSummary,
  MemberView,
  MessageView,
} from "@eta/client-contracts";
import type { PaletteId } from "../../src/components/palettes";
import { colorScheme, mount, signal, Storage, UrlScheme, View } from "nsh";
import { Palette, palette } from "../../src/components";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const members: MemberView[] = [
  { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
  { agentId: "ben", sessionId: null, lastSeq: 0, status: "idle" },
];

const message = (
  seq: number,
  author: MessageView["author"],
  text: string,
): MessageView => ({
  id: `m${seq}`,
  conversationId: "group",
  seq,
  kind: "message",
  author,
  status: "done",
  revision: 1,
  agentId: author === "agent" ? "ada" : null,
  text,
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  mentions: [],
  createdAt: 0,
  updatedAt: 0,
  data: {},
});

function Fixture(props: {
  initialSteward: string | null;
  paletteId: PaletteId;
  failSteward: boolean;
}) {
  const host = createHost();
  const steward = signal<string | null>(props.initialSteward);
  const calls = signal<string[]>([]);

  const summary = (): ConversationSummary => ({
    id: "group",
    projectId: "project",
    kind: "group",
    name: "Website redesign",
    archived: false,
    stewardId: steward(),
    participants: members,
    lastSeq: 2,
    readSeq: 2,
    unread: 0,
    preview: "",
    lastMessageAt: null,
    createdAt: 0,
    updatedAt: 0,
  });

  const syncConversation = () => {
    host.state.update((state) => ({
      ...state,
      status: "open",
      targets: {
        ...state.targets,
        agents: {
          version: 1,
          revisions: {},
          sections: {
            list: [
              { id: "ada", name: "Ada" },
              { id: "ben", name: "Ben" },
            ],
          },
        },
        conversations: {
          version: 1,
          revisions: {},
          sections: { list: [summary()] },
        },
        "conversations.group": {
          version: 1,
          revisions: {},
          sections: {
            info: {
              id: "group",
              projectId: "project",
              kind: "group",
              name: "Website redesign",
              stewardId: steward(),
              archived: false,
              createdAt: 0,
              updatedAt: 0,
            },
            members,
            timeline: {
              messages: [
                message(1, "user", "Check the header chip hover."),
                message(2, "agent", "Looking at it now."),
              ],
              hasMore: false,
              held: [],
            },
          },
        },
      },
    }));
  };

  syncConversation();
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>(target: string, action: string, payload?: unknown) => {
    calls.update((list) => [...list, `${target}.${action}`]);
    if (target === "conversations" && action === "setSteward") {
      if (props.failSteward) throw new Error("Failed to set steward");
      const next = (payload as { agentId: string | null }).agentId;
      steward.set(next);
      syncConversation();
    }
    return {} as T;
  };

  const c = () => palette(colorScheme(), props.paletteId);
  const noop = () => {};

  return (
    <Host.Provider value={host}>
      <Palette.Provider value={c}>
        <View style={{ flex: 1, backgroundColor: c().canvas }}>
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
      </Palette.Provider>
    </Host.Provider>
  );
}

async function main() {
  const url = UrlScheme.url();
  const params = new URLSearchParams(
    url && url.includes("?") ? url.slice(url.indexOf("?")) : "",
  );
  const rawSteward =
    params.get("steward") ?? (await Storage.getItem("steward"));
  const rawPalette =
    params.get("palette") ?? (await Storage.getItem("palette"));
  const rawFail =
    params.get("failSteward") ?? (await Storage.getItem("failSteward"));
  const initialSteward = rawSteward === "none" ? null : (rawSteward ?? "ada");
  const paletteId = (rawPalette as PaletteId | null) ?? "default";
  const failSteward = rawFail === "true";
  mount(() => (
    <Fixture
      initialSteward={initialSteward}
      paletteId={paletteId}
      failSteward={failSteward}
    />
  ));
}

void main();
