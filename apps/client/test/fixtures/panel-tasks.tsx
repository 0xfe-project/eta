import type { BoardTaskView } from "@eta/client-contracts";
import { mount, View, windowSize } from "nsh";
import { TasksTab } from "../../src/pages/chat/panel-tasks";
import { createHost, Host } from "../../src/services/host";

// The conversation panel's Tasks tab with three of this group's tasks, as wide as the panel is at
// the window's size: the desktop side panel, the tablet drawer, the whole phone screen.
const now = Date.now();

const task = (
  number: number,
  title: string,
  status: BoardTaskView["status"],
  minutesAgo: number,
  agentId: string,
) =>
  ({
    id: `t${number}`,
    number,
    title,
    status,
    createdBy: { kind: "agent", agentId },
    assigneeAgentId: agentId,
    conversationId: "group",
    runStatus: null,
    comments: 0,
    createdAt: now - minutesAgo * 60_000,
    updatedAt: now - minutesAgo * 60_000,
  }) as unknown as BoardTaskView;

const tasks = [
  task(2, "Write the login API tests", "in_progress", 185, "ada"),
  task(5, "Build the login API", "in_review", 12, "bo"),
  task(7, "Wire up the login page", "todo", 0, "ada"),
  task(9, "Design the login flow", "done", 1, "bo"),
];

function Fixture() {
  const host = createHost();
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
      tasks: { version: 1, revisions: {}, sections: { list: tasks } },
    },
  }));
  const width = () => {
    const window = windowSize().width;
    return window >= 1200 ? 360 : window >= 700 ? 400 : window;
  };
  return (
    <Host.Provider value={host}>
      <View style={{ width: width(), alignSelf: "flex-end" }}>
        <TasksTab conversationId="group" onTask={() => {}} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
