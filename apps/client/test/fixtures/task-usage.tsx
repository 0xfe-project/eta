import type {
  BoardTaskDetail,
  BoardTaskView,
  TaskUsageBrief,
  TaskUsageView,
} from "@eta/client-contracts";
import { mount, Scroll, View } from "nsh";
import { TasksTab } from "../../src/pages/chat/panel-tasks";
import { TaskUsageSection } from "../../src/pages/tasks/usage-section";
import { ViewMenu } from "../../src/pages/tasks/view-menu";
import { createHost, Host } from "../../src/services/host";

// The conversation panel's Tasks tab with tasks in each usage state, the Tasks page's View menu
// that switches usage on, and the Usage section of a task's page (always there). Storage
// `eta.tasks.usage` is the setting, as the app keeps it.
const now = Date.now();
const totals = (input: number, output: number, cacheRead: number) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  reasoning: null,
  total: input + output + cacheRead,
});
const brief = (extra: Partial<TaskUsageBrief>): TaskUsageBrief => ({
  tokens: null,
  model: null,
  models: 0,
  runs: 1,
  runsWithoutData: 0,
  liveSessionId: null,
  ...extra,
});

const task = (
  number: number,
  title: string,
  status: BoardTaskView["status"],
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
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    usage: null,
    ...extra,
  }) as unknown as BoardTaskView;

const tasks = [
  task(4, "Release v1.0", "in_progress", {
    subtasks: { total: 1, done: 0 },
    usageWithSubtasks: brief({
      tokens: totals(2_000_000, 100_000, 2_700_000),
      model: "gpt-5.1-codex",
      models: 2,
      runs: 5,
    }),
  }),
  task(7, "Package the desktop installer", "in_review", {
    parentId: "t4",
    usage: brief({
      tokens: totals(1_204_330, 98_112, 1_129_464),
      model: "gpt-5.1-codex",
      models: 2,
      runs: 4,
      runsWithoutData: 1,
    }),
  }),
  task(1, "Design the login flow", "in_review", {
    usage: brief({ runsWithoutData: 1 }),
  }),
  task(9, "Announce the release", "todo"),
];

const run = (
  runId: string,
  tokens: ReturnType<typeof totals> | null,
  model: string,
) => ({
  runId,
  taskId: "t7",
  agentId: "ada",
  mentioned: false,
  status: "completed" as const,
  startedAt: now - 600_000,
  finishedAt: now - 300_000,
  tokens,
  models: [{ provider: "openai", model, tokens }],
});
const usage: TaskUsageView = {
  taskId: "t7",
  includesSubtasks: true,
  taskIds: ["t7"],
  totals: {
    tokens: totals(1_204_330, 98_112, 1_129_464),
    runs: 4,
    runsWithoutData: 1,
  },
  models: [
    {
      provider: "openai",
      model: "gpt-5.1-codex",
      tokens: totals(1_100_000, 91_400, 1_100_000),
      runs: 2,
      runsWithoutData: 0,
    },
  ],
  runs: [
    run("r1", totals(600_000, 40_100, 400_000), "gpt-5.1-codex"),
    run("r2", null, "quiet"),
    run("r3", totals(500_000, 51_300, 700_000), "gpt-5.1-codex"),
    run("r4", totals(104_330, 6_712, 29_464), "claude-opus-4-5"),
  ],
};
const detail = {
  ...tasks[1],
  runs: [],
  children: [],
} as unknown as BoardTaskDetail;

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
        sections: { list: [{ id: "ada", name: "Ada" }] },
      },
      tasks: { version: 1, revisions: {}, sections: { list: tasks } },
      "tasks.t7": {
        version: 1,
        revisions: {},
        sections: { task: detail, activity: [], usage },
      },
    },
  }));
  return (
    <Host.Provider value={host}>
      <Scroll style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <ViewMenu />
        </View>
        <View style={{ width: 420 }}>
          <TasksTab conversationId="group" onTask={() => {}} />
        </View>
        <View style={{ padding: 16 }}>
          <TaskUsageSection item={detail} layout="desktop" />
        </View>
      </Scroll>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
