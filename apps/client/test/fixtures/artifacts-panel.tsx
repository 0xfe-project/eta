import type {
  AgentView,
  ArtifactView,
  BoardTaskView,
  ConversationSummary,
} from "@eta/client-contracts";
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
    { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
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

const task: BoardTaskView = {
  id: "task-5",
  number: 5,
  title: "Write the changelog",
  status: "in_progress",
  createdBy: { kind: "user" },
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: null,
  comments: 0,
  createdAt: 0,
  updatedAt: 0,
} as BoardTaskView;

/** Closed, so only the Tasks tab lists it. */
const done: BoardTaskView = {
  ...task,
  id: "task-6",
  number: 6,
  title: "Ship the redesign",
  status: "done",
};

const hour = 3_600_000;
const now = Date.now();
let count = 0;
function artifact(
  title: string,
  publisher: string | null,
  updatedAgo: number,
  createdAgo: number,
  versions = 1,
  taskId: string | null = null,
): ArtifactView {
  count += 1;
  return {
    id: `a${count}`,
    title,
    publisherAgentId: publisher,
    taskId,
    conversationId: "group",
    versions: Array.from({ length: versions }, (_, i) => ({
      number: versions - i,
    })) as ArtifactView["versions"],
    createdAt: now - createdAgo,
    updatedAt: now - updatedAgo,
  };
}

/**
 * Group "Website redesign" with 23 artifacts: "Plan 1".."Plan 20" by Ada (updated 1..20 hours
 * ago, created in the other order), "#5 Guided review" by Bo (newest, two versions, task #5),
 * "Ｇuided tour" by Bo (full-width Ｇ, 30 hours ago) and "Changelog" by Cyrus (ten days ago,
 * three versions, task #5). Another group's artifact must never show.
 */
const artifacts: ArtifactView[] = [
  artifact("#5 Guided review", "bo", hour / 2, 48 * hour, 2, "task-5"),
  ...Array.from({ length: 20 }, (_, i) =>
    artifact(`Plan ${i + 1}`, "ada", (i + 1) * hour, (20 - i) * hour),
  ),
  artifact("Ｇuided tour", "bo", 30 * hour, 30 * hour),
  artifact("Changelog", "cy", 240 * hour, 300 * hour, 3, "task-5"),
  { ...artifact("Elsewhere", "ada", 0, 0), conversationId: "other" },
];

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
      artifacts: list(artifacts),
      tasks: list([task, done]),
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
