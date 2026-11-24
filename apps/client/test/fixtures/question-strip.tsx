import type {
  ConversationSummary,
  HistoryResult,
  InteractionView,
  MessageView,
} from "@eta/client-contracts";
import { mount, signal, Text, UrlScheme, View } from "nsh";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

/*
 * A group conversation with 40 messages (Ada replies to each of the user's) and questions waiting,
 * picked by the opening URL:
 * eta://fixture/end   the question is on the last reply, on screen when the conversation opens;
 * eta://fixture/early the question is on an early reply, far above what is on screen;
 * eta://fixture/older the question is on a reply older than the loaded window, one page back;
 * eta://fixture/task  the question comes from a task's run (no reply here); the task opens;
 * eta://fixture/many  three questions: one on the last reply, two on early ones.
 */
const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Release",
  archived: false,
  stewardId: "Ada",
  participants: [
    { agentId: "Ada", sessionId: "s-ada", lastSeq: 0, status: "idle" },
  ],
  lastSeq: 40,
  readSeq: 40,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const message = (seq: number): MessageView => {
  const agent = seq % 2 === 0;
  return {
    id: `m${seq}`,
    conversationId: "group",
    seq,
    kind: "message",
    author: agent ? "agent" : "user",
    status: "done",
    revision: 1,
    agentId: agent ? "Ada" : null,
    text: agent ? `Reply number ${seq}.` : `Prompt number ${seq}.`,
    thinking: "",
    rootMessageId: agent ? `m${seq - 1}` : null,
    replyToId: agent ? `m${seq - 1}` : null,
    mentions: [],
    createdAt: seq,
    updatedAt: seq,
    data: {},
  };
};

const question = (
  id: string,
  replyId: string | null,
  prompt: string,
  createdAt: number,
): InteractionView => ({
  id,
  sessionId: replyId ? "s-ada" : "s-task",
  questionId: id,
  agentId: "Ada",
  conversationId: "group",
  replyId,
  prompt,
  options: ["Yes", "No"],
  multi: false,
  status: "pending",
  answer: null,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
});

function Fixture() {
  const host = createHost();
  const scenario = UrlScheme.url()?.replace("eta://fixture/", "") ?? "";
  // The loaded window starts at m11 when there is an older page, else at m1.
  const first = scenario === "older" ? 11 : 1;
  const messages = Array.from({ length: 41 - first }, (_, i) =>
    message(first + i),
  );
  const questions: InteractionView[] =
    scenario === "end"
      ? [question("q-end", "m40", "Ship rc.9 today?", 1)]
      : scenario === "early"
        ? [question("q-early", "m4", "Bring the IME fix along?", 1)]
        : scenario === "older"
          ? [question("q-older", "m4", "Keep the old installer?", 1)]
          : scenario === "task"
            ? [question("q-task", null, "Which branch should I cut?", 1)]
            : [
                question("q-end", "m40", "Ship rc.9 today?", 3),
                question("q-early", "m4", "Bring the IME fix along?", 1),
                question("q-six", "m6", "Tag it as a prerelease?", 2),
              ];
  host.state.update((s) => ({
    ...s,
    status: "open",
    targets: {
      ...s.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: { list: [{ id: "Ada", name: "Ada" }] },
      },
      inbox: { version: 1, revisions: {}, sections: { list: questions } },
      conversations: {
        version: 1,
        revisions: {},
        sections: { list: [summary] },
      },
      "conversations.group": {
        version: 1,
        revisions: {},
        sections: {
          timeline: { messages, hasMore: first > 1, held: [] },
        },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: {
          list:
            scenario === "task"
              ? [
                  {
                    id: "t-cut",
                    number: 7,
                    title: "Cut the release branch",
                    conversationId: "group",
                    status: "in_progress",
                    runStatus: "running",
                  },
                ]
              : [],
        },
      },
      ...(scenario === "task"
        ? {
            "tasks.t-cut": {
              version: 1,
              revisions: {},
              sections: {
                task: {
                  id: "t-cut",
                  runs: [{ id: "r1", sessionId: "s-task", status: "running" }],
                },
              },
            },
          }
        : {}),
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  host.call = async <T,>(target: string, op: string): Promise<T> => {
    if (target === "conversations" && op === "history")
      return {
        conversationId: "group",
        messages: Array.from({ length: 10 }, (_, i) => message(i + 1)),
        hasMore: false,
      } satisfies HistoryResult as T;
    return undefined as T;
  };
  const opened = signal("");
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{opened() ? `Opened task ${opened()}` : "No task opened"}</Text>
        <Conversation
          id="group"
          layout="desktop"
          onTask={opened.set}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
