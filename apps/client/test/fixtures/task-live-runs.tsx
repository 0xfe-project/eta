import type {
  AgentMessage,
  BoardTaskDetail,
  TaskRunView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { mount, signal, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { createHost, Host } from "../../src/services/host";

// A task Ada executes, with Bo mentioned on it and answering in a session of its own. "Only Bo"
// ends Ada's run (the task goes to review) while Bo still answers.
const start = Date.now() - 5 * 60_000;

const said = (session: string, text: string): ViewMessageRow[] => [
  {
    entryId: `${session}-1`,
    seq: 1,
    at: start + 1000,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      timestamp: start + 1000,
    } as unknown as AgentMessage,
  },
];

const session = (id: string, text: string) => ({
  version: 1,
  revisions: {},
  sections: {
    transcript: { messages: said(id, text) },
    core: { session: id, running: true },
  },
});

const run = (
  id: string,
  agentId: string | null,
  sessionId: string,
  status: TaskRunView["status"],
): TaskRunView => ({
  id,
  agentId,
  status,
  queueReason: null,
  machineId: null,
  sessionId,
  continuesRunId: null,
  workspace: null,
  nudged: false,
  error: null,
  createdAt: start,
  startedAt: start,
  finishedAt: status === "running" ? null : start + 60_000,
});

const ada = { kind: "agent" as const, agentId: "ada" };

const task = (onlyBo: boolean) =>
  ({
    id: "t1",
    number: 1,
    title: "Fix the footer",
    status: onlyBo ? "in_review" : "in_progress",
    createdBy: ada,
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: onlyBo ? "completed" : "running",
    comments: 1,
    createdAt: start,
    updatedAt: start,
    description: "Fix the footer links.",
    artifacts: [],
    projectId: null,
    workspace: {
      mode: "local",
      base: { kind: "head" },
      path: null,
      branch: null,
    },
    originConversationId: "group",
    runs: [
      run("r-ada", null, "s-ada", onlyBo ? "completed" : "running"),
      run("r-bo", "bo", "s-bo", "running"),
    ],
  }) as unknown as BoardTaskDetail;

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  const onlyBo = signal(false);
  const panel = signal(false);
  const seed = () =>
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
              { id: "bo", name: "Bo" },
            ],
          },
        },
        tasks: {
          version: 1,
          revisions: {},
          sections: { list: [task(onlyBo())], archived: [] },
        },
        "tasks.t1": {
          version: 1,
          revisions: {},
          sections: { task: task(onlyBo()), activity: [] },
        },
        "sessions.s-ada": session("s-ada", "Ada reads the footer."),
        "sessions.s-bo": session("s-bo", "Bo looks the question up."),
      },
    }));
  seed();
  host.call = async <T,>() => undefined as T;
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
        <View style={{ flexDirection: "row" }}>
          <Button
            label="Only Bo"
            onPress={() => {
              onlyBo.set(true);
              seed();
            }}
          />
          <Button label="Side panel" onPress={() => panel.set(true)} />
        </View>
        <If
          when={panel()}
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
