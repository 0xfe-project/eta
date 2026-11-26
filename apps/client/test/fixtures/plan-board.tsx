import type { BoardTaskView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Label, Screen } from "../../src/components";
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
  const tablet = signal(false);
  const opened = signal("");
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
  const completedChain = [
    task(100, "Draft spec", { status: "done" }),
    task(101, "Approve spec", {
      status: "done",
      dependsOn: [{ taskId: "t100" }],
    } as unknown as Change),
  ];
  const twoTaskChain = (
    firstStatus: BoardTaskView["status"] = "in_progress",
  ) => [
    task(20, "Prepare migration", { status: firstStatus }),
    task(21, "Run migration", {
      status: "todo",
      dependsOn: [{ taskId: "t20" }],
      waitingOn: [
        {
          taskId: "t20",
          number: 20,
          title: "Prepare migration",
          state: firstStatus,
        },
      ],
    } as unknown as Change),
  ];
  return (
    <Host.Provider value={host}>
      <Screen.Provider value={() => (tablet() ? "tablet" : "desktop")}>
        <View style={{ flexDirection: "row" }}>
          {button("push again", () => push(tasks(renamed)))}
          {button("rename", () => {
            renamed = { 2: { title: "Build the sign-in API" } };
            push(tasks(renamed));
          })}
          {button("wait", () =>
            push(
              tasks({ ...renamed, 4: waitsFor(3, "Write the login tests") }),
            ),
          )}
          {button("cancel", () =>
            push(tasks({ ...renamed, 3: { status: "cancelled" } })),
          )}
          {button("chains", () =>
            push([
              task(435, "Fix sync", { status: "in_review" }),
              task(437, "Ship CLI", { status: "in_progress" }),
              task(440, "Cut release", {
                status: "todo",
                dependsOn: [{ taskId: "t435" }, { taskId: "t437" }],
                waitingOn: [
                  {
                    taskId: "t435",
                    number: 435,
                    title: "Fix sync",
                    state: "in_review",
                  },
                  {
                    taskId: "t437",
                    number: 437,
                    title: "Ship CLI",
                    state: "in_progress",
                  },
                ],
              } as unknown as Change),
              ...completedChain,
              task(5, "Tidy the changelog"),
            ]),
          )}
          {button("completed only", () =>
            push([...completedChain, task(5, "Tidy the changelog")]),
          )}
          {button("two-task chain", () => push(twoTaskChain()))}
          {button("cancel chain task", () => push(twoTaskChain("cancelled")))}
          {button("empty", () =>
            push([task(5, "Tidy the changelog"), task(6, "Update readme")]),
          )}
          {button("tablet", () => tablet.set(true))}
        </View>
        <If when={opened()}>
          <Label>{`opened:${opened()}`}</Label>
        </If>
        <TaskPlanBoard
          items={host.tasks()}
          tablet={tablet()}
          onOpen={(id) => opened.set(id)}
        />
      </Screen.Provider>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
