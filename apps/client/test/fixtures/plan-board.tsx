import type { BoardTaskView } from "@eta/client-contracts";
import { mount, View } from "nsh";
import { TaskPlanBoard } from "../../src/pages/tasks/plan";
import { createHost, Host } from "../../src/services/host";

// The Tasks page's Plan view over one parent with three subtasks (#3 waits for #2) and a task
// under nothing. The buttons push the task list again the way the host does, every task a new
// object: as is (a running task's tokens moved), with #2 renamed, with #4 waiting for #3, or with
// #3 cancelled.
const now = Date.now();

type Change = Partial<BoardTaskView>;

const task = (number: number, title: string, change: Change = {}) =>
  ({
    id: `t${number}`,
    number,
    title,
    status: "todo",
    createdBy: { kind: "agent", agentId: "ada" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: null,
    comments: 0,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    ...change,
  }) as unknown as BoardTaskView;

const waitsFor = (number: number, title: string) =>
  ({
    dependsOn: [{ taskId: `t${number}` }],
    waitingOn: [{ taskId: `t${number}`, title, state: "todo" }],
  }) as unknown as Change;

function tasks(changes: Record<number, Change> = {}) {
  return [
    task(1, "Ship the login page", {
      subtasks: { total: 3, done: 0 },
      ...changes[1],
    } as Change),
    task(2, "Build the login API", {
      parentId: "t1",
      status: "in_progress",
      ...changes[2],
    }),
    task(3, "Write the login tests", {
      parentId: "t1",
      ...waitsFor(2, "Build the login API"),
      ...changes[3],
    } as Change),
    task(4, "Wire up the login form", { parentId: "t1", ...changes[4] }),
    task(5, "Tidy the changelog", changes[5]),
  ];
}

function Fixture() {
  const host = createHost();
  const push = (list: BoardTaskView[]) =>
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        tasks: { version: 1, revisions: {}, sections: { list } },
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
    },
  }));
  push(tasks());
  let renamed: Record<number, Change> = {};
  const button = (label: string, press: () => void) => (
    <View
      role="button"
      accessibilityLabel={label}
      onPress={press}
      style={{ width: 20, height: 20 }}
    />
  );
  return (
    <Host.Provider value={host}>
      <View style={{ flexDirection: "row" }}>
        {button("push again", () => push(tasks(renamed)))}
        {button("rename", () => {
          renamed = { 2: { title: "Build the sign-in API" } };
          push(tasks(renamed));
        })}
        {button("wait", () =>
          push(tasks({ ...renamed, 4: waitsFor(3, "Write the login tests") })),
        )}
        {button("cancel", () =>
          push(tasks({ ...renamed, 3: { status: "cancelled" } })),
        )}
      </View>
      <TaskPlanBoard items={host.tasks()} onOpen={() => {}} />
    </Host.Provider>
  );
}

mount(() => <Fixture />);
