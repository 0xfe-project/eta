import type {
  BoardTaskDetail,
  PluginView,
  RoutineInfo,
} from "@eta/client-contracts";
import { mount, signal, Storage, View } from "nsh";
import { Button, colors, Label, row } from "../../src/components";
import { ToastLayer } from "../../src/components/toast";
import { space } from "../../src/components/tokens";
import { StewardMenu } from "../../src/pages/chat/members";
import { PluginEnabled } from "../../src/pages/plugins/plugin-name";
import { Routines } from "../../src/pages/routines/routines";
import { ArchiveSettings } from "../../src/pages/settings/archive";
import { createTaskDetailState } from "../../src/pages/tasks/task-detail-state";
import { createHost, Host } from "../../src/services/host";

const now = Date.UTC(2026, 10, 24, 12, 0);

function Fixture(props: { mode: string }) {
  const c = colors();
  const host = createHost();
  const shouldFail = signal(false);
  const calls = signal<string[]>([]);
  const resolvers: (() => void)[] = [];
  const rejectors: ((err: Error) => void)[] = [];

  const plugin = signal<PluginView>({
    name: "github",
    version: "1.0.0",
    description: "GitHub tools",
    source: { kind: "local", path: "/tmp/github" },
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
  });

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
            const payload = args as { enabled: boolean };
            plugin.update((item) => ({ ...item, enabled: payload.enabled }));
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
        </View>
        <Label>{`Calls: ${calls().length}`}</Label>

        <If when={props.mode === "plugin"}>
          <PluginEnabled item={plugin()} />
          <StewardMenu
            conversationId="c-arch"
            members={[
              { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
              { agentId: "ben", sessionId: null, lastSeq: 0, status: "idle" },
            ]}
            current="ada"
          />
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

        <If when={props.mode === "task"}>
          <TaskOptimisticHarness calls={calls} />
        </If>

        <ToastLayer />
      </View>
    </Host.Provider>
  );
}

function TaskOptimisticHarness(props: { calls: () => string[] }) {
  const state = createTaskDetailState({ id: "t1", layout: "desktop" });
  return (
    <View style={{ gap: space[8] }}>
      <Label>{`Title: ${state.task()?.title ?? ""}`}</Label>
      <Label>{`Activity count: ${state.activity().length}`}</Label>
      <Label>{`Comment status: ${state.commentStatus.state().status}`}</Label>
      <Label>{`Edit status: ${state.editStatus.state().status}`}</Label>
      <Button
        label="Rename task"
        onPress={() => {
          state.editTitle.set("Updated title");
          state.renaming.set(true);
          state.saveTitle();
        }}
      />
      <Button label="Retry edit" onPress={state.retryEdit} />
      <Button
        label="Post comment"
        onPress={() => void state.post("Ship it!")}
      />
      <Label>{`Last call: ${props.calls().at(-1) ?? ""}`}</Label>
    </View>
  );
}

void Storage.getItem("mode").then((mode) =>
  mount(() => <Fixture mode={mode ?? "plugin"} />),
);
