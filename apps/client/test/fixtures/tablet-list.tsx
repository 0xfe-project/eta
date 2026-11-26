import type { ConversationSummary } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, View, windowSize } from "nsh";
import { Workspace } from "../../src/app/workspace";
import { createHost, Host } from "../../src/services/host";

// The whole workspace on a host with one group, the layout picked by the window width as the app
// does: a phone under 600, a tablet under 1200, else a desktop.

const group: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: null,
  participants: [],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: list([]),
      projects: list([]),
      conversations: list([group]),
      "conversations.group": {
        sections: { timeline: { messages: [], hasMore: false, held: [] } },
        revisions: {},
        version: 0,
      },
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
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
        <Workspace
          layout={layout()}
          theme="light"
          onTheme={noop}
          paletteId="default"
          onPalette={noop}
          flavor="mocha"
          onFlavor={noop}
          chatWidth="wide"
          onChatWidth={noop}
          chatRail={false}
          onChatRail={noop}
          onFonts={noop}
          onConnect={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
