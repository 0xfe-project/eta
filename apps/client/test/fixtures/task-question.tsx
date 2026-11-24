import type {
  BoardTaskDetail,
  InteractionView,
  TaskRunView,
} from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { createHost, Host } from "../../src/services/host";

/*
 * Task #1, which Ada executes, whose run asked "Which branch should I cut?" and waits. The task
 * opens on its page at the window's layout, or (eta://fixture/panel) in the chat's task panel.
 * Answering marks the question answered, as the host does, and says what was sent.
 */
const start = Date.now() - 60_000;

const run: TaskRunView = {
  id: "r1",
  agentId: null,
  status: "running",
  queueReason: null,
  machineId: null,
  sessionId: "s-task",
  continuesRunId: null,
  workspace: null,
  nudged: false,
  error: null,
  createdAt: start,
  startedAt: start,
  finishedAt: null,
};

const task = {
  id: "t1",
  number: 1,
  title: "Cut the release branch",
  status: "in_progress",
  createdBy: { kind: "user" },
  assigneeAgentId: "ada",
  conversationId: "group",
  runStatus: "running",
  comments: 0,
  createdAt: start,
  updatedAt: start,
  description: "Cut the branch the release builds from.",
  artifacts: [],
  projectId: null,
  workspace: {
    mode: "local",
    base: { kind: "head" },
    path: null,
    branch: null,
  },
  originConversationId: "group",
  runs: [run],
} as unknown as BoardTaskDetail;

const question = (status: InteractionView["status"]): InteractionView => ({
  id: "q-task",
  sessionId: "s-task",
  questionId: "call-1",
  agentId: "ada",
  conversationId: "group",
  replyId: null,
  prompt: "Which branch should I cut?",
  options: ["main", "release/0.9"],
  multi: false,
  status,
  answer: null,
  revision: status === "pending" ? 1 : 2,
  createdAt: start + 1000,
  updatedAt: start + 1000,
});

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  const panel = UrlScheme.url() === "eta://fixture/panel";
  const sent = signal("");
  const seed = (status: InteractionView["status"]) =>
    host.state.update((state) => ({
      ...state,
      status: "open",
      targets: {
        ...state.targets,
        agents: {
          version: 1,
          revisions: {},
          sections: { list: [{ id: "ada", name: "Ada" }] },
        },
        inbox: {
          version: 1,
          revisions: {},
          sections: { list: [question(status)] },
        },
        tasks: {
          version: 1,
          revisions: {},
          sections: { list: [task], archived: [] },
        },
        "tasks.t1": {
          version: 1,
          revisions: {},
          sections: { task, activity: [] },
        },
      },
    }));
  seed("pending");
  host.call = async <T,>(target: string, op: string, input?: unknown) => {
    if (target === "inbox" && op === "answer") {
      sent.set(JSON.stringify(input));
      seed("answered");
    }
    return undefined as T;
  };
  const layout = () =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{sent() ? `Sent ${sent()}` : "Nothing sent"}</Text>
        <If
          when={panel}
          else={
            <TaskDetail
              id="t1"
              layout={layout()}
              onClose={noop}
              onTask={noop}
            />
          }
        >
          <PanelTask
            id="t1"
            layout="desktop"
            onClose={noop}
            onTask={noop}
            onArtifact={noop}
          />
        </If>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
