import type { Layout } from "../../src/components";
import { mount, Storage, View, windowSize } from "nsh";
import { Pending } from "../../src/pages/chat/pending";
import { createHost, Host } from "../../src/services/host";

// One pending question (with options and, in storage `context`, the reason it was asked) in a
// conversation's pending panel; pressing it opens the global question dialog, a sheet on a phone.
function layoutOf(width: number): Layout {
  return width >= 1200 ? "desktop" : width >= 700 ? "tablet" : "phone";
}

function Fixture(props: { context?: string }) {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [{ id: "atlas", name: "Atlas" }] },
      },
      inbox: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "q1",
              sessionId: "s1",
              questionId: "c1",
              agentId: "atlas",
              conversationId: "group",
              replyId: null,
              prompt: "Which database should we use?",
              context: props.context,
              options: ["Postgres", "SQLite"],
              multi: false,
              status: "pending",
              answer: null,
              revision: 1,
              createdAt: Date.UTC(2026, 10, 21, 9, 0),
              updatedAt: Date.UTC(2026, 10, 21, 9, 0),
            },
          ],
        },
      },
    },
  }));
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Pending conversationId="group" layout={layoutOf(windowSize().width)} />
      </View>
    </Host.Provider>
  );
}

void Storage.getItem("context").then((context) =>
  mount(() => <Fixture context={context ?? undefined} />),
);
