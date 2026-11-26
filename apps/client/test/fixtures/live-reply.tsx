import type {
  AgentMessage,
  MemberView,
  MessageView,
  ViewMessageRow,
} from "@eta/client-contracts";
import { mount, signal, View, windowSize } from "nsh";
import { Button, Label } from "../../src/components";
import { ToastLayer } from "../../src/components/toast";
import { Message } from "../../src/pages/chat/message";
import { createHost, Host } from "../../src/services/host";

/** How Ada's reply stands: at work, or over in one of the ways a run ends. */
type Ending = "working" | "done" | "plain" | "stopped" | "failed";

const at = Date.UTC(2026, 10, 21, 9, 30);
const thought = "Look at the provider config.";
const note = "I'll check config.json first.";
const answer = "The baseUrl is missing /v1.";
const plain = "Nothing to look up: the answer is 42.";

function row(seq: number, message: Record<string, unknown>): ViewMessageRow {
  return {
    entryId: `e${seq}`,
    seq,
    at: at + seq,
    message: { timestamp: at + seq, ...message } as unknown as AgentMessage,
  };
}

/** The session at work: the briefing, a thought, words, a call, an insert, words. */
const working = [
  row(1, { role: "user", content: "Why does the model return 401?" }),
  row(2, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: thought },
      { type: "text", text: note },
      {
        type: "toolCall",
        id: "t1",
        name: "read",
        arguments: { path: "config.json" },
      },
    ],
  }),
  row(3, {
    role: "toolResult",
    toolCallId: "t1",
    content: [{ type: "text", text: "baseUrl: https://example.invalid" }],
    isError: false,
  }),
  row(4, { role: "user", content: "Also check the key." }),
  row(5, { role: "assistant", content: [{ type: "text", text: answer }] }),
];

/** A session with a tool still running (no toolResult yet). */
const runningTool = [
  row(1, { role: "user", content: "Check config.json" }),
  row(2, {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "t-run",
        name: "read",
        arguments: { path: "config.json" },
      },
    ],
  }),
];

/** A reply that calls nothing: its words alone. */
const plainRun = [
  row(1, { role: "user", content: "What is six times seven?" }),
  row(2, { role: "assistant", content: [{ type: "text", text: plain }] }),
];

/** A reply that just started: no steps and no words yet. */
const waitingRun = [
  row(1, { role: "user", content: "Why does the model return 401?" }),
];

/** The first step has landed, with the answer streaming beneath it. */
const firstStepRun = [
  row(1, { role: "user", content: "Why does the model return 401?" }),
  row(2, {
    role: "assistant",
    content: [
      { type: "thinking", thinking: thought },
      { type: "text", text: plain },
    ],
  }),
];

const activity = [
  {
    id: "t1",
    name: "read",
    input: { path: "config.json" },
    output: "baseUrl",
    status: "completed",
  },
];

/** What the host keeps on the row once the run is over, per ending: it is saved after the run's last row. */
function saved(ending: Ending): Partial<MessageView> {
  return { updatedAt: at + 100, ...kept(ending) };
}

function kept(ending: Ending): Partial<MessageView> {
  const process = [
    { type: "thinking", text: thought },
    { type: "text", text: note },
    { type: "tool", id: "t1" },
  ];
  if (ending === "plain")
    return {
      status: "done",
      text: plain,
      data: { process: [{ type: "text", text: plain }] },
    };
  if (ending === "stopped")
    return { status: "stopped", text: "", data: { activity, process } };
  if (ending === "failed")
    return {
      status: "failed",
      text: "Provider said 500.",
      data: { activity, process, code: "run_failed" },
    };
  return {
    status: "done",
    text: answer,
    data: {
      activity,
      process: [...process, { type: "steer" }, { type: "text", text: answer }],
    },
  };
}

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  const ending = signal<Ending>("working");
  const sessionMode = signal<
    "working" | "runningTool" | "plain" | "waiting" | "firstStep"
  >("working");
  const retried = signal(0);
  /** Rows the run wrote after the fixture's own. */
  const later = signal<ViewMessageRow[]>([]);
  const reloaded = signal(false);
  const baseRows = () => {
    switch (sessionMode()) {
      case "runningTool":
        return runningTool;
      case "plain":
        return plainRun;
      case "waiting":
        return waitingRun;
      case "firstStep":
        return firstStepRun;
      default:
        return working;
    }
  };
  const sessionTarget = () => ({
    version: 1,
    revisions: {},
    sections: {
      transcript: {
        messages: [...baseRows(), ...later()],
      },
      core: { session: "s-ada", running: true },
    },
  });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [{ id: "ada", name: "Ada" }] },
      },
      "sessions.s-ada": sessionTarget(),
    },
  }));
  const item = (): MessageView => ({
    id: "ada-1",
    conversationId: "group",
    seq: 2,
    kind: "message",
    author: "agent",
    agentId: "ada",
    text: "",
    thinking: "",
    status: "working",
    revision: 1,
    mentions: [],
    rootMessageId: null,
    replyToId: null,
    data: { runFrom: 0 },
    createdAt: at,
    updatedAt: at,
    ...(ending() === "working" ? {} : saved(ending())),
  });
  const members = (): MemberView[] => [
    {
      agentId: "ada",
      sessionId: reloaded() ? null : "s-ada",
      lastSeq: 1,
      status: ending() === "working" ? "working" : "idle",
      ...(ending() === "working" ? { activeReplyId: "ada-1" } : {}),
    },
  ];
  return (
    <Host.Provider value={host}>
      <View>
        <Message
          item={item()}
          additions={[]}
          canInsert={false}
          onInsert={() => {}}
          phone={windowSize().width < 600}
          members={members()}
          onArtifact={() => {}}
          onWidgetDraft={() => {}}
          onTask={() => {}}
          onRetry={() => retried.update((n) => n + 1)}
          onReadDraft={() => {}}
          registerAction={() => () => {}}
        />
        <View testID="below-message">
          <Label>{`Retried: ${retried()}`}</Label>
        </View>
        <Button
          label="Start waiting"
          onPress={() => {
            sessionMode.set("waiting");
            host.state.update((state) => ({
              ...state,
              targets: { ...state.targets, "sessions.s-ada": sessionTarget() },
            }));
          }}
        />
        <Button
          label="First step"
          onPress={() => {
            sessionMode.set("firstStep");
            host.state.update((state) => ({
              ...state,
              targets: { ...state.targets, "sessions.s-ada": sessionTarget() },
            }));
          }}
        />
        <Button
          label="Running tool"
          onPress={() => {
            sessionMode.set("runningTool");
            host.state.update((state) => ({
              ...state,
              targets: { ...state.targets, "sessions.s-ada": sessionTarget() },
            }));
          }}
        />
        <Button
          label="Complete tool"
          onPress={() => {
            sessionMode.set("working");
            host.state.update((state) => ({
              ...state,
              targets: { ...state.targets, "sessions.s-ada": sessionTarget() },
            }));
          }}
        />
        <Button
          label="Write without tools"
          onPress={() => {
            sessionMode.set("plain");
            host.state.update((state) => ({
              ...state,
              targets: { ...state.targets, "sessions.s-ada": sessionTarget() },
            }));
          }}
        />
        <Button
          label="Write more"
          // The run writes on a moment later, while the reader has the panel open.
          onPress={() =>
            setTimeout(() => {
              later.set([
                row(6, {
                  role: "assistant",
                  content: [{ type: "text", text: "Checking the key next." }],
                }),
              ]);
              host.state.update((state) => ({
                ...state,
                targets: {
                  ...state.targets,
                  "sessions.s-ada": sessionTarget(),
                },
              }));
            }, 500)
          }
        />
        <Button
          label="Finish"
          onPress={() =>
            ending.set(sessionMode() === "plain" ? "plain" : "done")
          }
        />
        <Button label="End stopped" onPress={() => ending.set("stopped")} />
        <Button label="End failed" onPress={() => ending.set("failed")} />
        <Button
          label="Reload"
          onPress={() => {
            // A page opened afresh: the row as saved, no session in view.
            reloaded.set(true);
            host.state.update((state) => {
              const targets = { ...state.targets };
              delete targets["sessions.s-ada"];
              return { ...state, targets };
            });
          }}
        />
        <ToastLayer />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
