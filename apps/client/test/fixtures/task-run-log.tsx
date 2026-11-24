import type {
  AgentMessage,
  TaskRunView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { mount, signal, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { TaskRunLog } from "../../src/pages/tasks/run-log";
import { createHost, Host } from "../../src/services/host";

const at = Date.UTC(2026, 10, 21, 9, 30);

function row(seq: number, message: Record<string, unknown>): ViewMessageRow {
  return {
    entryId: `e${seq}`,
    seq,
    at: at + seq * 1000,
    message: {
      timestamp: at + seq * 1000,
      ...message,
    } as unknown as AgentMessage,
  };
}

/** A task run's session: the brief, a call and its result, the summary. */
const rows = [
  row(1, { role: "user", content: "Fix the footer links." }),
  row(2, {
    role: "assistant",
    content: [
      { type: "text", text: "Looking for the footer first." },
      {
        type: "toolCall",
        id: "t1",
        name: "read",
        arguments: { path: "src/footer.tsx" },
      },
    ],
  }),
  row(3, {
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "export function Footer() {}" }],
    isError: false,
  }),
  row(4, {
    role: "assistant",
    content: [{ type: "text", text: "The links point at /old." }],
  }),
];

const run: TaskRunView = {
  id: "run-1",
  agentId: null,
  status: "completed",
  queueReason: null,
  machineId: null,
  sessionId: "s-task",
  continuesRunId: null,
  workspace: null,
  nudged: false,
  error: null,
  createdAt: at,
  startedAt: at,
  finishedAt: at + 5000,
};

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [{ id: "bo", name: "Bo" }] },
      },
      "sessions.s-task": {
        version: 1,
        revisions: {},
        sections: {
          transcript: { messages: rows },
          core: { session: "s-task", running: false },
        },
      },
    },
  }));
  const open = signal(false);
  const layout = () =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  return (
    <Host.Provider value={host}>
      <View>
        <Button label="View process" onPress={() => open.set(true)} />
        <If when={open()}>
          <TaskRunLog
            run={run}
            runs={[run]}
            executor="Bo"
            agentId="bo"
            layout={layout()}
            stopping={false}
            onStop={() => {}}
            onClose={() => open.set(false)}
          />
        </If>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
