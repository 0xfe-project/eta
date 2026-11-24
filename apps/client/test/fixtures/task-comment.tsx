import type {
  BoardTaskDetail,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, Storage, Text, View, windowSize } from "nsh";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { TaskDetail } from "../../src/pages/tasks/task-detail";
import { createHost, Host } from "../../src/services/host";

// One task in the state storage `state` names, opened in the conversation panel or on its page
// (storage `surface`: "panel" or "page"). A comment the client sends is listed under "Sent:" and
// lands on the task's timeline, as the host's answer would put it there, with its files. The host
// takes files with a comment (`tasks.attach`) unless storage `host` is "old"; with "blind" the
// executor's model takes no images, which the host adds to the comment once it was handed over.
const start = Date.UTC(2026, 10, 21, 9, 0);

function run(status: TaskRunView["status"]): TaskRunView {
  return {
    id: "r1",
    agentId: null,
    status,
    queueReason: null,
    machineId: null,
    sessionId: "s1",
    continuesRunId: null,
    workspace: null,
    nudged: false,
    error: null,
    createdAt: start,
    startedAt: start,
    finishedAt: status === "running" ? null : start + 60_000,
  };
}

const states: Record<string, Partial<BoardTaskDetail>> = {
  in_review: { status: "in_review", runs: [run("completed")] },
  done: { status: "done", runs: [run("completed")] },
  blocked: { status: "blocked", runs: [run("completed")] },
  backlog: { status: "backlog" },
  cancelled: { status: "cancelled", runs: [run("interrupted")] },
  archived: {
    status: "done",
    archivedAt: start + 120_000,
    runs: [run("completed")],
  },
  waiting: {
    status: "todo",
    waitingOn: [
      {
        taskId: "t1",
        number: 1,
        title: "Design the login flow",
        status: "todo",
        state: "waiting",
        via: null,
      },
    ],
  },
  running: {
    status: "in_progress",
    runStatus: "running",
    runs: [run("running")],
  },
  parent: {
    status: "in_progress",
    subtasks: { total: 2, done: 1 },
    children: [
      { taskId: "t3", number: 3, title: "Write the tests", status: "todo" },
      { taskId: "t4", number: 4, title: "Ship it", status: "done" },
    ],
  },
  "parent-splitting": {
    status: "in_progress",
    runStatus: "running",
    subtasks: { total: 1, done: 0 },
    runs: [run("running")],
    children: [
      { taskId: "t3", number: 3, title: "Write the tests", status: "todo" },
    ],
  },
};

function taskIn(state: string): BoardTaskDetail {
  return {
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
    runs: [],
    ...states[state],
  } as unknown as BoardTaskDetail;
}

function layoutOf(width: number): Layout {
  return width >= 1200 ? "desktop" : width >= 700 ? "tablet" : "phone";
}

const uploaded = new Map<
  string,
  { id: string; name: string; contentType: string; size: number }
>();

function Fixture(props: {
  surface: string;
  state: string;
  old: boolean;
  blind: boolean;
}) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const task = taskIn(props.state);
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: props.old ? [] : ["tasks.attach"],
    targets: {
      ...state.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            { id: "lin", name: "Lin" },
            { id: "ada", name: "Ada" },
          ],
        },
      },
      tasks: { version: 1, revisions: {}, sections: { list: [task] } },
      "tasks.t2": {
        version: 1,
        revisions: {},
        sections: { task, activity: [] },
      },
    },
  }));
  host.call = (async (target: string, action: string, args: unknown) => {
    const { taskId, body, mentions, attachments } = args as {
      taskId?: string;
      body?: string;
      mentions?: string[];
      attachments?: string[];
    };
    if (action === "attach") {
      // One chunk is the whole file here: the upload is done at once.
      const chunk = args as {
        uploadId: string;
        name: string;
        contentType?: string;
        data: string;
        last?: boolean;
      };
      const file = {
        id: chunk.uploadId,
        name: chunk.name,
        contentType: chunk.contentType ?? "application/octet-stream",
        size: Buffer.from(chunk.data, "base64").byteLength,
      };
      uploaded.set(file.id, file);
      return { attachment: chunk.last ? file : null };
    }
    const files = (attachments ?? []).flatMap((id) => {
      const file = uploaded.get(id);
      return file ? [file] : [];
    });
    sent.set([
      ...sent(),
      `${target}.${action} ${taskId ?? ""} ${body ?? ""}${
        mentions?.length ? ` mentions=${mentions.join("+")}` : ""
      }${files.length ? ` files=${files.map((file) => file.name).join("+")}` : ""}`,
    ]);
    if (action !== "comment" || (!body && !files.length)) return undefined;
    const entry: TaskActivityView = {
      id: `c${sent().length}`,
      kind: "comment",
      runId: null,
      actor: { kind: "user", agentId: null },
      body: body ?? "",
      data: files.length ? { attachments: files } : {},
      createdAt: start + 180_000,
    };
    host.state.update((state) => {
      const current = state.targets["tasks.t2"]!;
      return {
        ...state,
        targets: {
          ...state.targets,
          "tasks.t2": {
            ...current,
            sections: {
              ...current.sections,
              activity: [
                ...(current.sections.activity as TaskActivityView[]),
                entry,
              ],
            },
          },
        },
      };
    });
    // The executor's model takes no images: a moment later the host says so on the comment.
    if (files.length && props.blind)
      setTimeout(() => {
        host.state.update((state) => {
          const current = state.targets["tasks.t2"]!;
          const activity = (
            current.sections.activity as TaskActivityView[]
          ).map((item) =>
            item.id === entry.id
              ? { ...item, data: { ...item.data, imagesUnseenBy: ["ada"] } }
              : item,
          );
          return {
            ...state,
            targets: {
              ...state.targets,
              "tasks.t2": {
                ...current,
                sections: { ...current.sections, activity },
              },
            },
          };
        });
      }, 50);
    return { task, activity: entry };
  }) as typeof host.call;
  const noop = () => {};
  const layout = () => layoutOf(windowSize().width);
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(", ")}`}</Text>
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

void Promise.all([
  Storage.getItem("surface"),
  Storage.getItem("state"),
  Storage.getItem("host"),
]).then(([surface, state, old]) =>
  mount(() => (
    <Fixture
      surface={surface ?? "panel"}
      state={state ?? "in_review"}
      old={old === "old"}
      blind={old === "blind"}
    />
  )),
);
