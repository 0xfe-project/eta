import type {
  BoardTaskDetail,
  TaskActivityView,
  TaskRunView,
} from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Label } from "../../src/components";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { createHost, Host } from "../../src/services/host";

// One task whose timeline has every kind of entry, in the order the sandbox for #247 seeded it.
const minute = 60_000;
const start = Date.UTC(2026, 10, 21, 0, 34);
const at = (n: number) => start + n * minute;
const user = { kind: "user" as const, agentId: null };
const system = { kind: "system" as const, agentId: null };
const ada = { kind: "agent" as const, agentId: "ada" };
const captain = { kind: "agent" as const, agentId: "captain" };

const run = (id: string, status: TaskRunView["status"]): TaskRunView =>
  ({
    id,
    agentId: null,
    status,
    queueReason: null,
    machineId: null,
    sessionId: null,
    continuesRunId: null,
    workspace: null,
    nudged: false,
    error: null,
    createdAt: at(0),
    startedAt: at(0),
    finishedAt: status === "running" ? null : at(1),
  }) as TaskRunView;

let id = 0;
const entry = (
  n: number,
  kind: TaskActivityView["kind"],
  actor: TaskActivityView["actor"],
  body: string | null = null,
  data: Record<string, unknown> = {},
  runId: string | null = null,
): TaskActivityView =>
  ({
    id: `a${++id}`,
    kind,
    runId,
    actor,
    body,
    data,
    createdAt: at(n),
  }) as TaskActivityView;

const activity: TaskActivityView[] = [
  entry(0, "created", ada),
  entry(1, "status", user, null, { from: "backlog", to: "todo" }),
  entry(2, "dependency", user, null, {
    action: "added",
    taskId: "t1",
    number: 1,
    title: "Design the login flow",
  }),
  // Written before the host kept the other task's id: found by its number.
  entry(2.1, "dependency", user, null, {
    action: "added",
    number: 3,
    title: "Pick a session store",
  }),
  // A task deleted since, and one this board never had: named, not opened.
  entry(2.2, "dependency", user, null, {
    action: "added",
    taskId: "gone",
    number: 9,
    title: "Draft the old login copy",
  }),
  entry(3, "run_queued", system, null, {}, "r1"),
  entry(3.1, "run_started", system, null, {}, "r1"),
  entry(12, "comment", ada, "Should the session cookie be Lax or Strict?"),
  entry(14, "comment", user, "Lax."),
  entry(15, "comment", user, "And keep the cookie name eta_session."),
  entry(29, "artifact", ada, null, {
    artifactId: "art",
    title: "Login API benchmark",
    version: 1,
  }),
  entry(29.5, "artifact", ada, null, {
    artifactId: "deleted-art",
    title: "Early benchmark draft",
    version: 1,
  }),
  entry(30, "run_completed", system, null, {}, "r1"),
  entry(30.1, "status", system, null, { from: "in_progress", to: "in_review" }),
  entry(34, "comment", captain, "Review: add a per-IP rate limit."),
  entry(34.1, "status", captain, null, {
    from: "in_review",
    to: "in_progress",
  }),
  entry(45, "title", user, null, { to: "Build the login API" }),
  entry(46, "parent", user, null, {
    from: null,
    to: { taskId: "t2", number: 2, title: "Ship sign-in" },
  }),
  entry(47, "subtask", ada, null, {
    action: "added",
    taskId: "t5",
    number: 5,
    title: "Write the login API tests",
  }),
  entry(52, "run_started", system, null, {}, "r2"),
  entry(55, "run_failed", system, "the provider returned 529", {}, "r2"),
  entry(60, "dependency", system, null, {
    action: "blocked",
    number: 1,
    title: "Design the login flow",
  }),
  entry(70, "run_started", system, null, {}, "r3"),
  entry(110, "comment", user, "Looks good. I'll check the benchmark tonight."),
];

const board = (id: string, number: number, title: string) => ({
  id,
  number,
  title,
  status: "todo",
  createdBy: ada,
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: null,
  comments: 0,
  createdAt: at(0),
  updatedAt: at(0),
});

const version = (number: number) => ({
  number,
  createdAt: at(29),
  shareUrl: null,
  sharedAt: null,
});

const task = {
  id: "t4",
  number: 4,
  title: "Build the login API",
  status: "in_progress",
  createdBy: ada,
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: "running",
  comments: 5,
  createdAt: at(0),
  updatedAt: at(110),
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
  // The third run is still going: its start is said under the thread, not in it.
  runs: [run("r1", "completed"), run("r2", "failed"), run("r3", "running")],
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
        sections: {
          list: [
            { id: "ada", name: "Ada" },
            { id: "captain", name: "Captain", systemRole: "captain" },
          ],
        },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            board("t1", 1, "Design the login flow"),
            board("t2", 2, "Ship sign-in"),
            board("t4", 4, "Build the login API"),
            board("t5", 5, "Write the login API tests"),
          ],
          archived: [board("t3", 3, "Pick a session store")],
        },
      },
      artifacts: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "art",
              title: "Login API benchmark",
              publisherAgentId: "ada",
              taskId: "t4",
              conversationId: "group",
              // A newer version came after the one the timeline names.
              versions: [version(2), version(1)],
              createdAt: at(29),
              updatedAt: at(40),
            },
          ],
        },
      },
      "tasks.t4": {
        version: 1,
        revisions: {},
        sections: { task, activity },
      },
    },
  }));
  host.call = async <T,>() => undefined as T;
  const noop = () => {};
  // What the timeline last opened, said on screen.
  const opened = signal("");
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Label>{opened() ? `opened ${opened()}` : ""}</Label>
        <PanelTask
          id="t4"
          layout="desktop"
          onClose={noop}
          onTask={(id) => opened.set(`task ${id}`)}
          onArtifact={(artifact, number) =>
            opened.set(`artifact ${artifact.id} v${number ?? "latest"}`)
          }
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
