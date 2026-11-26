import type { BoardTaskDetail, TaskActivityView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Compact, Label } from "../../src/components";
import { PanelTask } from "../../src/pages/chat/panel-task";
import { createHost, Host } from "../../src/services/host";

const minute = 60_000;
const start = Date.UTC(2026, 10, 21, 0, 34);
const at = (n: number) => start + n * minute;
const user = { kind: "user" as const, agentId: null };
const system = { kind: "system" as const, agentId: null };
const ada = { kind: "agent" as const, agentId: "ada" };

const longTitle = "Revert PR #957 (Antigravity ACP auto-discovery & preset)";
const deletedArtifactTitle =
  "Old draft (Antigravity ACP auto-discovery & preset)";
const deletedTaskTitle =
  "Removed PR #958 (Antigravity ACP auto-discovery & preset)";

let id = 0;
const entry = (
  n: number,
  kind: TaskActivityView["kind"],
  actor: TaskActivityView["actor"],
  data: Record<string, unknown> = {},
): TaskActivityView =>
  ({
    id: `n${++id}`,
    kind,
    runId: null,
    actor,
    body: null,
    data,
    createdAt: at(n),
  }) as TaskActivityView;

const activity: TaskActivityView[] = [
  entry(1, "dependency", user, {
    action: "added",
    taskId: "t957",
    number: 957,
    title: longTitle,
  }),
  entry(2, "dependency", system, {
    action: "blocked",
    taskId: "t957",
    number: 957,
    title: longTitle,
  }),
  entry(3, "artifact", ada, {
    artifactId: "art-long",
    title: longTitle,
    version: 1,
  }),
  entry(4, "artifact", ada, {
    artifactId: "deleted-long",
    title: deletedArtifactTitle,
    version: 1,
  }),
  entry(5, "dependency", user, {
    action: "added",
    taskId: "gone",
    number: 958,
    title: deletedTaskTitle,
  }),
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

const task = {
  id: "t4",
  number: 4,
  title: "Fix activity sentence wrapping",
  status: "in_progress",
  createdBy: ada,
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: null,
  comments: 0,
  createdAt: at(0),
  updatedAt: at(5),
  description: "Check narrow timeline activity lines.",
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
          list: [{ id: "ada", name: "Ada" }],
        },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: {
          list: [board("t4", 4, task.title), board("t957", 957, longTitle)],
          archived: [],
        },
      },
      artifacts: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            {
              id: "art-long",
              title: longTitle,
              publisherAgentId: "ada",
              taskId: "t4",
              conversationId: "group",
              versions: [
                {
                  number: 1,
                  createdAt: at(3),
                  shareUrl: null,
                  sharedAt: null,
                },
              ],
              createdAt: at(3),
              updatedAt: at(3),
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
  const opened = signal("");
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Label>{opened() ? `opened ${opened()}` : ""}</Label>
        <Compact>
          <PanelTask
            id="t4"
            layout="desktop"
            onClose={noop}
            onTask={(taskId) => opened.set(`task ${taskId}`)}
            onArtifact={(artifact, number) =>
              opened.set(`artifact ${artifact.id} v${number ?? "latest"}`)
            }
          />
        </Compact>
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
