import type { BoardTaskDetail, BoardTaskStatus } from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, Storage, Text, View, windowSize } from "nsh";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { createHost, Host } from "../../src/services/host";

// One running task, opened in the conversation panel or on its page (storage `surface`: "panel"
// or "page"). The host's status changes wait until the test presses "Answer" or "Fail".
const start = Date.UTC(2026, 10, 21, 9, 0);

const task = {
  id: "t2",
  number: 2,
  title: "Build the login API",
  status: "in_progress",
  createdBy: { kind: "agent", agentId: "ada" },
  assigneeAgentId: "ada",
  conversationId: "group",
  runStatus: null,
  comments: 0,
  createdAt: start,
  updatedAt: start,
  description: "Add POST /api/login.",
  artifacts: [],
  projectId: null,
  workspace: {
    mode: "local",
    base: { kind: "head" },
    path: null,
    branch: null,
  },
  originConversationId: "group",
  dependents: [
    {
      taskId: "t3",
      number: 3,
      title: "Wire up the login page",
      status: "todo",
      requireDone: false,
      state: "waiting",
    },
  ],
  runs: [],
} as unknown as BoardTaskDetail;

function layoutOf(width: number): Layout {
  return width >= 1200 ? "desktop" : width >= 700 ? "tablet" : "phone";
}

function Fixture(props: { surface: string }) {
  const host = createHost();
  const sent = signal<string[]>([]);
  let answer: ((ok: boolean) => void) | undefined;
  const setStatus = (status: BoardTaskStatus) =>
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        "tasks.t2": {
          ...state.targets["tasks.t2"]!,
          sections: {
            ...state.targets["tasks.t2"]!.sections,
            task: {
              ...(state.targets["tasks.t2"]!.sections.task as object),
              status,
            },
          },
        },
      },
    }));
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
      tasks: {
        version: 1,
        revisions: {},
        sections: { list: [task] },
      },
      "tasks.t2": {
        version: 1,
        revisions: {},
        sections: { task, activity: [] },
      },
    },
  }));
  host.call = (async (target: string, action: string, args: unknown) => {
    const status = (args as { status?: BoardTaskStatus }).status;
    sent.set([...sent(), `${target}.${action} ${status ?? ""}`.trim()]);
    if (!status) return undefined;
    const ok = await new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    answer = undefined;
    if (!ok) throw new Error("the host is busy");
    setStatus(status);
    return undefined;
  }) as typeof host.call;
  const noop = () => {};
  const layout = () => layoutOf(windowSize().width);
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", gap: 8, padding: 4 }}>
          <View role="button" onPress={() => answer?.(true)}>
            <Text>Answer</Text>
          </View>
          <View role="button" onPress={() => answer?.(false)}>
            <Text>Fail</Text>
          </View>
          <Text style={{ flex: 1 }}>{`Sent: ${sent().join(", ")}`}</Text>
        </View>
        <If
          when={props.surface === "page"}
          else={
            <View
              style={{
                flex: 1,
                width: "100%",
                maxWidth: 400,
                alignSelf: "flex-end",
              }}
            >
              <PanelTask
                id="t2"
                layout={layout()}
                onClose={noop}
                onTask={noop}
                onArtifact={noop}
              />
            </View>
          }
        >
          <TaskDetail id="t2" layout={layout()} onClose={noop} onTask={noop} />
        </If>
      </View>
    </Host.Provider>
  );
}

void Storage.getItem("surface").then((surface) =>
  mount(() => <Fixture surface={surface ?? "panel"} />),
);
