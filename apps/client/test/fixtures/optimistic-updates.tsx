import type {
  BoardTaskDetail,
  ComposioPluginView,
  LlmAccounts,
  PluginView,
  RoutineInfo,
  RoutineSummary,
  TaskActivityView,
} from "@eta/client-contracts";
import { mount, signal, Storage, View } from "nsh";
import { Button, colors, Label, row, SmoothScroll } from "../../src/components";
import { NotificationHost } from "../../src/components/notifications";
import { space } from "../../src/components/tokens";
import { StewardMenu } from "../../src/pages/chat/members";
import { ComposioPluginSwitch } from "../../src/pages/plugins/composio-plugins";
import { PluginEnabled } from "../../src/pages/plugins/plugin-name";
import { Routines } from "../../src/pages/routines/routines";
import { ArchiveSettings } from "../../src/pages/settings/archive";
import { ModelSourceList } from "../../src/pages/settings/models/source-list";
import { TaskActivity } from "../../src/pages/tasks/activity";
import {
  createTaskDetailState,
  type TaskDetailState,
} from "../../src/pages/tasks/task-detail-state";
import { TaskCommentBox } from "../../src/pages/tasks/task-fields";
import { TaskOverview } from "../../src/pages/tasks/task-overview";
import { createHost, Host } from "../../src/services/host";

const now = Date.UTC(2026, 10, 24, 12, 0);

function makePlugin(name: string): PluginView {
  return {
    name,
    version: "1.0.0",
    description: `${name} tools`,
    source: { kind: "local", path: `/tmp/${name}` },
    enabled: true,
    state: "ready",
    skills: [],
    servers: [],
    fields: [],
    reports: [],
    requires: [],
    machines: [],
    headers: [],
    agents: [],
    problem: null,
  };
}

function Fixture(props: { mode: string }) {
  const c = colors();
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  const shouldFail = signal(false);
  const calls = signal<string[]>([]);
  const resolvers: (() => void)[] = [];
  const rejectors: ((err: Error) => void)[] = [];

  const compactPlugin = signal<PluginView>(makePlugin("compact-plugin"));
  const fullPlugin = signal<PluginView>(makePlugin("github"));
  const composioPlugin = signal<ComposioPluginView>({
    name: "@composio/gmail",
    slug: "gmail",
    state: "ready",
    enabled: true,
  });
  const steward = signal<string | null>("ada");

  const routine: RoutineInfo = {
    id: "r1",
    name: "Daily Standup",
    enabled: true,
    schedule: { kind: "daily", time: "09:00" },
    timezone: "UTC",
    nextRunAt: null,
    revising: false,
    unseenReports: 0,
    unseenFailures: 0,
    createdAt: now - 86_400_000,
    updatedAt: now,
  };

  const taskDetail: BoardTaskDetail = {
    id: "t1",
    number: 1,
    title: "Initial title",
    description: "Initial description",
    status: "todo",
    assigneeAgentId: "ada",
    createdBy: { kind: "user", agentId: null },
    conversationId: "c1",
    projectId: null,
    parentId: null,
    workspace: { mode: "local", path: null, base: null, branch: null },
    createdAt: now - 10_000,
    updatedAt: now,
    archivedAt: null,
    archivedBy: null,
    runs: [],
    runStatus: null,
    artifacts: [],
    originConversationId: null,
    comments: 0,
  };

  const accounts: LlmAccounts = {
    ready: true,
    connectors: [{ id: "codex", name: "Codex", flow: "oauth_device" }],
    connections: [
      {
        id: "acc1",
        connector: "codex",
        label: "Work",
        state: "active",
        createdAt: "2026-01-01",
      },
    ],
  };

  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: [
      "routines.update",
      "tasks.comment",
      "tasks.update",
      "tasks.unarchive",
    ],
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            { id: "ada", name: "Ada" },
            { id: "ben", name: "Ben" },
          ],
        },
      },
      conversations: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "c-arch",
              name: "Old chat",
              kind: "group",
              archived: true,
              projectId: null,
              stewardId: "ada",
              participants: [],
              unread: 0,
              updatedAt: now,
              lastMessageAt: now,
              preview: "",
            },
          ],
        },
      },
      routines: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "r1",
              name: "Daily Standup",
              enabled: true,
              schedule: { kind: "daily", time: "09:00" },
              timezone: "UTC",
              nextRunAt: null,
              runs: [],
              unseenReports: 0,
              unseenFailures: 0,
            },
          ],
          status: { captainOn: true, reason: null },
        },
      },
      "routines.r1": {
        version: 1,
        revisions: {},
        sections: {
          info: routine,
          briefs: [{ version: 1, text: "Summarize progress" }],
          runs: [],
        },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: {
          list: [taskDetail],
          archived: [
            {
              ...taskDetail,
              id: "t-arch",
              number: 9,
              title: "Archived cleanup",
              archivedAt: now - 1000,
              archivedBy: "user",
            },
          ],
        },
      },
      "tasks.t1": {
        version: 1,
        revisions: {},
        sections: {
          task: taskDetail,
          activity: [],
        },
      },
      llm: {
        version: 1,
        revisions: {},
        sections: {
          accounts,
          models: [],
        },
      },
      providers: {
        version: 1,
        revisions: {},
        sections: {
          config: { revision: "r1", providers: [] },
          checks: {},
        },
      },
    },
  }));

  host.call = ((target: string, action: string, args?: unknown) => {
    calls.update((all) => [
      ...all,
      `${target}.${action}:${JSON.stringify(args)}`,
    ]);
    return new Promise((resolve, reject) => {
      if (shouldFail()) {
        rejectors.push(reject);
      } else {
        resolvers.push(() => {
          if (target === "plugins" && action === "setEnabled") {
            const payload = args as { name: string; enabled: boolean };
            if (payload.name === "compact-plugin") {
              compactPlugin.update((item) => ({
                ...item,
                enabled: payload.enabled,
              }));
            } else if (payload.name === "github") {
              fullPlugin.update((item) => ({
                ...item,
                enabled: payload.enabled,
              }));
            } else if (payload.name === "@composio/gmail") {
              composioPlugin.update((item) => ({
                ...item,
                enabled: payload.enabled,
              }));
            }
          } else if (target === "conversations" && action === "setSteward") {
            const payload = args as { agentId: string | null };
            steward.set(payload.agentId);
          } else if (target === "routines" && action === "update") {
            const payload = args as { routineId: string; enabled: boolean };
            host.state.update((state) => {
              const currentList = state.targets.routines?.sections
                .list as RoutineSummary[];
              const currentInfo = state.targets["routines.r1"]?.sections
                .info as RoutineInfo;
              return {
                ...state,
                targets: {
                  ...state.targets,
                  routines: {
                    ...state.targets.routines!,
                    sections: {
                      ...state.targets.routines!.sections,
                      list: currentList.map((item) =>
                        item.id === payload.routineId
                          ? { ...item, enabled: payload.enabled }
                          : item,
                      ),
                    },
                  },
                  "routines.r1": {
                    ...state.targets["routines.r1"]!,
                    sections: {
                      ...state.targets["routines.r1"]!.sections,
                      info: { ...currentInfo, enabled: payload.enabled },
                    },
                  },
                },
              };
            });
          } else if (target === "tasks" && action === "unarchive") {
            const payload = args as { taskId: string };
            host.state.update((state) => {
              const archived = state.targets.tasks?.sections
                .archived as BoardTaskDetail[];
              return {
                ...state,
                targets: {
                  ...state.targets,
                  tasks: {
                    ...state.targets.tasks!,
                    sections: {
                      ...state.targets.tasks!.sections,
                      archived: archived.filter(
                        (item) => item.id !== payload.taskId,
                      ),
                    },
                  },
                },
              };
            });
          } else if (target === "llm" && action === "setEnabled") {
            const payload = args as { id: string; enabled: boolean };
            host.state.update((state) => {
              const current = state.targets.llm?.sections
                .accounts as LlmAccounts;
              return {
                ...state,
                targets: {
                  ...state.targets,
                  llm: {
                    ...state.targets.llm!,
                    sections: {
                      ...state.targets.llm!.sections,
                      accounts: {
                        ...current,
                        connections: current.connections.map((item) =>
                          item.id === payload.id
                            ? {
                                ...item,
                                state: payload.enabled ? "active" : "disabled",
                              }
                            : item,
                        ),
                      },
                    },
                  },
                },
              };
            });
          } else if (target === "tasks" && action === "update") {
            const payload = args as {
              taskId: string;
              title?: string;
              description?: string;
            };
            host.state.update((state) => {
              const currentTask = state.targets["tasks.t1"]?.sections
                .task as BoardTaskDetail;
              const currentList = state.targets.tasks?.sections
                .list as BoardTaskDetail[];
              const patch = {
                ...(payload.title !== undefined
                  ? { title: payload.title }
                  : {}),
                ...(payload.description !== undefined
                  ? { description: payload.description }
                  : {}),
              };
              return {
                ...state,
                targets: {
                  ...state.targets,
                  tasks: {
                    ...state.targets.tasks!,
                    sections: {
                      ...state.targets.tasks!.sections,
                      list: currentList.map((item) =>
                        item.id === payload.taskId
                          ? { ...item, ...patch }
                          : item,
                      ),
                    },
                  },
                  "tasks.t1": {
                    ...state.targets["tasks.t1"]!,
                    sections: {
                      ...state.targets["tasks.t1"]!.sections,
                      task: { ...currentTask, ...patch },
                    },
                  },
                },
              };
            });
          } else if (target === "tasks" && action === "comment") {
            const payload = args as { body: string; clientId?: string };
            host.state.update((state) => {
              const currentActivity = state.targets["tasks.t1"]?.sections
                .activity as TaskActivityView[];
              const rowItem: TaskActivityView = {
                id: payload.clientId ?? `comment-${currentActivity.length + 1}`,
                kind: "comment",
                actor: { kind: "user", agentId: null },
                body: payload.body,
                runId: null,
                data: {},
                createdAt: now,
              };
              return {
                ...state,
                targets: {
                  ...state.targets,
                  "tasks.t1": {
                    ...state.targets["tasks.t1"]!,
                    sections: {
                      ...state.targets["tasks.t1"]!.sections,
                      activity: [...currentActivity, rowItem],
                    },
                  },
                },
              };
            });
          }
          resolve({} as never);
        });
      }
    });
  }) as typeof host.call;

  function flushOk() {
    while (resolvers.length) resolvers.shift()?.();
  }
  function flushFail() {
    while (rejectors.length) rejectors.shift()?.(new Error("Host rejected"));
  }

  return (
    <Host.Provider value={host}>
      <View
        style={{
          flex: 1,
          backgroundColor: c().canvas,
          padding: space[16],
          gap: space[12],
        }}
      >
        <View style={{ ...row, gap: space[8] }}>
          <Button
            label={shouldFail() ? "Mode: fail" : "Mode: succeed"}
            onPress={() => shouldFail.set(!shouldFail())}
          />
          <Button label="Resolve" onPress={flushOk} />
          <Button label="Reject" onPress={flushFail} />
          <Label>{`Calls: ${calls().length}`}</Label>
          <If when={props.mode === "task-comment"}>
            <Label>{`Last call: ${calls().at(-1) ?? ""}`}</Label>
          </If>
        </View>

        <If when={props.mode === "plugin"}>
          <View testID="plugin-compact" style={{ ...row, gap: space[8] }}>
            <PluginEnabled item={compactPlugin()} compact />
            <View testID="plugin-compact-after">
              <Label>After compact</Label>
            </View>
          </View>
          <View testID="plugin-full">
            <PluginEnabled item={fullPlugin()} />
          </View>
          <View testID="plugin-after">
            <Label>After plugin</Label>
          </View>
          <View testID="composio-row" style={{ ...row, gap: space[8] }}>
            <ComposioPluginSwitch
              view={composioPlugin()}
              onChanged={() => {}}
            />
          </View>
          <View testID="composio-after">
            <Label>After composio</Label>
          </View>
          <View style={{ ...row, gap: space[8] }}>
            <StewardMenu
              conversationId="c-arch"
              members={[
                { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
                { agentId: "ben", sessionId: null, lastSeq: 0, status: "idle" },
              ]}
              current={steward()}
            />
            <View testID="steward-after">
              <Label>After steward</Label>
            </View>
          </View>
        </If>

        <If when={props.mode === "routine"}>
          <View style={{ flex: 1 }}>
            <Routines layout="desktop" initialId="r1" onCaptain={() => {}} />
          </View>
        </If>

        <If when={props.mode === "archive"}>
          <View style={{ flex: 1 }}>
            <ArchiveSettings />
          </View>
        </If>

        <If when={props.mode === "models"}>
          <ModelSourceList
            phone={false}
            summaries={[]}
            onProvider={() => {}}
            onAccount={() => {}}
            onRef={() => {}}
          />
        </If>

        <If when={props.mode === "task"}>
          <TaskOverviewHarness mode="overview" />
        </If>

        <If when={props.mode === "task-comment"}>
          <TaskOverviewHarness mode="comment" />
        </If>

        <NotificationHost />
      </View>
    </Host.Provider>
  );
}

function TaskOverviewHarness(props: { mode: "overview" | "comment" }) {
  const state: TaskDetailState = createTaskDetailState({
    id: "t1",
    layout: "desktop",
  });
  return (
    <If
      when={props.mode === "overview"}
      else={
        <View style={{ flex: 1, gap: space[8] }}>
          <SmoothScroll style={{ flex: 1 }}>
            <Label>{`Activity count: ${state.activity().length}`}</Label>
            <TaskActivity
              heading="desktop"
              entries={state.activity()}
              runs={[]}
              createdBy={state.task()!.createdBy}
              onLog={() => {}}
              onTask={() => {}}
              onArtifact={() => {}}
            />
          </SmoothScroll>
          <TaskCommentBox state={state} />
        </View>
      }
    >
      <View style={{ flex: 1, gap: space[8] }}>
        <View style={{ ...row, gap: space[8] }}>
          <Button
            label="Rename task"
            onPress={() => {
              state.editTitle.set("Updated title");
              state.renaming.set(true);
              state.saveTitle();
            }}
          />
          <Button
            label="Save description"
            onPress={() => state.saveDescription("Updated description")}
          />
        </View>
        <View style={{ flex: 1 }}>
          <TaskOverview
            item={state.task()!}
            layout="desktop"
            onTask={() => {}}
            state={state}
          />
        </View>
      </View>
    </If>
  );
}

void Storage.getItem("mode").then((mode) =>
  mount(() => <Fixture mode={mode ?? "plugin"} />),
);
