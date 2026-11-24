import type { BoardTaskView } from "@eta/client-contracts";
import { mount, signal, Storage, View, windowSize } from "nsh";
import { PhoneConversationInfo } from "../../src/pages/chat/conversation-info";
import { ContextTasks, TasksTab } from "../../src/pages/chat/panel-tasks";
import { createHost, Host } from "../../src/services/host";

// A group's tasks with a parent among them, in the surface storage `surface` names: the Context
// tab's Tasks section ("context"), the Tasks tab ("tasks", the default) or the phone's info sheet
// ("phone"). #1 has three subtasks, one of them (#4) a parent too; #7 and #8 stand alone. #11 is
// discussed in this group, but its parent #10 is another group's.
const now = Date.now();

const task = (
  number: number,
  title: string,
  status: BoardTaskView["status"],
  minutesAgo: number,
  extra: Partial<BoardTaskView> = {},
) =>
  ({
    id: `t${number}`,
    number,
    title,
    status,
    createdBy: { kind: "agent", agentId: "ada" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: null,
    comments: 0,
    createdAt: now - minutesAgo * 60_000,
    updatedAt: now - minutesAgo * 60_000,
    ...extra,
  }) as unknown as BoardTaskView;

const tasks = [
  task(1, "Ship the onboarding", "in_progress", 300, {
    subtasks: { total: 3, done: 1 },
  }),
  task(2, "Design the screens", "done", 200, { parentId: "t1" }),
  task(3, "Build the screens", "in_review", 5, { parentId: "t1" }),
  task(4, "Test on phones", "todo", 100, {
    parentId: "t1",
    subtasks: { total: 1, done: 0 },
  }),
  task(6, "Test on Android", "todo", 100, { parentId: "t4" }),
  task(7, "Write the release notes", "in_review", 60),
  task(8, "Update the favicon", "todo", 30),
  task(10, "Move CI to new runners", "in_progress", 400, {
    conversationId: "other",
    subtasks: { total: 1, done: 0 },
  }),
  task(11, "Port the test jobs", "in_progress", 400, { parentId: "t10" }),
];

function Fixture(props: { surface: string }) {
  const host = createHost();
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
      tasks: { version: 1, revisions: {}, sections: { list: tasks } },
    },
  }));
  const width = () => Math.min(400, windowSize().width);
  return (
    <Host.Provider value={host}>
      <View style={{ width: width(), alignSelf: "flex-end", flex: 1 }}>
        <If when={props.surface === "context"}>
          <ContextTasks
            tasks={host.tasks().filter((t) => t.conversationId === "group")}
            onTask={() => {}}
            onViewAll={() => {}}
          />
        </If>
        <If when={props.surface === "tasks"}>
          <TasksTab conversationId="group" onTask={() => {}} />
        </If>
        <If when={props.surface === "phone"}>
          <PhoneConversationInfo
            id="group"
            name="Website"
            members={[]}
            onClose={() => {}}
            onInspect={() => {}}
            onTask={() => {}}
            onArtifact={() => {}}
            artifactFilters={signal({}) as never}
          />
        </If>
      </View>
    </Host.Provider>
  );
}

void Storage.getItem("surface").then((surface) =>
  mount(() => <Fixture surface={surface ?? "tasks"} />),
);
