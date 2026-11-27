import type {
  AgentView,
  BoardTaskView,
  ConversationSummary,
  InteractionView,
  ProjectView,
} from "@eta/client-contracts";
import { mount, Storage, View } from "nsh";
import { grow, Label, Screen } from "../../src/components";
import { space } from "../../src/components/tokens";
import { ChatList } from "../../src/navigation/chat-list";
import { Pending } from "../../src/pages/chat/pending";
import { createHost, Host, relativeTime } from "../../src/services/host";

const agentTemplate: Omit<AgentView, "id" | "name" | "systemRole"> = {
  instructions: "",
  persona: "",
  model: "claude-sonnet",
  runtime: "eta",
  thinkingLevel: null,
  machineId: null,
  plugins: [],
  skippedPlugins: [],
  avatarSeed: null,
  avatarSeeds: [],
  home: "",
  homeProjectId: "p1",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const agents: AgentView[] = [
  { ...agentTemplate, id: "ada", name: "Ada", systemRole: null },
  { ...agentTemplate, id: "bo", name: "Bo", systemRole: null },
  { ...agentTemplate, id: "captain", name: "Captain", systemRole: "captain" },
];

const projects: ProjectView[] = [
  {
    id: "p1",
    machineId: "m1",
    path: "/workspace/eta",
    display: "~/workspace/eta",
    name: "eta",
    kind: "project",
    ownerAgentId: null,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

function Fixture(props: { mode: string; showRefs: boolean }) {
  const now = Date.now();
  const times = [
    now - 10_000,
    now - 30 * 60_000,
    now - 12 * 3_600_000,
    now - 2 * 86_400_000,
  ] as const;

  const conversations: ConversationSummary[] = [
    {
      id: "c1",
      projectId: "p1",
      kind: "group",
      name: "Mobile layout verification and QA thread",
      archived: false,
      stewardId: null,
      participants: [
        { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
      ],
      lastSeq: 1,
      readSeq: 1,
      unread: 0,
      preview: "Verified phone spacing across row headers and badges",
      lastMessageAt: times[0],
      createdAt: times[0],
      updatedAt: times[0],
    },
    {
      id: "c2",
      projectId: "p1",
      kind: "group",
      name: "Release coordination with long conversation title",
      archived: false,
      stewardId: null,
      participants: [
        { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
        { agentId: "bo", sessionId: null, lastSeq: 0, status: "idle" },
      ],
      lastSeq: 3,
      readSeq: 1,
      unread: 2,
      preview: "Checking unread dot alignment beside multi-char timestamps",
      lastMessageAt: times[1],
      createdAt: times[1],
      updatedAt: times[1],
    },
    {
      id: "c3",
      projectId: "p1",
      kind: "group",
      name: "Design system token cleanup for mobile rows",
      archived: false,
      stewardId: null,
      participants: [
        { agentId: "bo", sessionId: null, lastSeq: 0, status: "idle" },
      ],
      lastSeq: 1,
      readSeq: 1,
      unread: 0,
      preview: "Auditing narrow phone containers for text wrapping",
      lastMessageAt: times[2],
      createdAt: times[2],
      updatedAt: times[2],
    },
    {
      id: "c4",
      projectId: "p1",
      kind: "group",
      name: "Client runtime localization and date formatting",
      archived: false,
      stewardId: null,
      participants: [
        { agentId: "ada", sessionId: null, lastSeq: 0, status: "idle" },
      ],
      lastSeq: 1,
      readSeq: 1,
      unread: 0,
      preview: "Short month-day timestamps must stay on one line",
      lastMessageAt: times[3],
      createdAt: times[3],
      updatedAt: times[3],
    },
  ];

  const inbox: InteractionView[] = [
    {
      id: "q1",
      sessionId: "s1",
      questionId: "qi1",
      agentId: "ada",
      conversationId: "c1",
      replyId: null,
      prompt: "Confirm deploying the updated mobile row layout?",
      options: ["Approve", "Hold"],
      multi: false,
      status: "pending",
      answer: null,
      revision: 1,
      createdAt: times[0],
      updatedAt: times[0],
    },
    {
      id: "q2",
      sessionId: "s2",
      questionId: "qi2",
      agentId: "bo",
      conversationId: "c2",
      replyId: null,
      prompt: "Select the target locale bundle for phone regression checks",
      options: ["en-US", "zh-CN"],
      multi: false,
      status: "pending",
      answer: null,
      revision: 1,
      createdAt: times[1],
      updatedAt: times[1],
    },
  ];

  const tasks: BoardTaskView[] = [
    {
      id: "t1",
      number: 481,
      title: "Keep phone list timestamps on a single line",
      status: "in_review",
      createdBy: { kind: "agent", agentId: "ada" },
      assigneeAgentId: "ada",
      conversationId: "c3",
      runStatus: "completed",
      comments: 0,
      createdAt: times[2],
      updatedAt: times[2],
    },
    {
      id: "t2",
      number: 482,
      title: "Verify Pending inbox row alignment on narrow screens",
      status: "in_review",
      createdBy: { kind: "agent", agentId: "bo" },
      assigneeAgentId: "bo",
      conversationId: "c4",
      runStatus: "completed",
      comments: 0,
      createdAt: times[3],
      updatedAt: times[3],
    },
  ];

  const host = createHost();
  const list = <T,>(items: T[]) => ({
    version: 1,
    revisions: {},
    sections: { list: items },
  });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: list(agents),
      projects: list(projects),
      conversations: list(conversations),
      inbox: list(inbox),
      tasks: list(tasks),
      captain: { version: 1, revisions: {}, sections: { operations: [] } },
      routines: list([]),
    },
  }));

  const noop = () => {};
  return (
    <Screen.Provider value={() => "phone"}>
      <Host.Provider value={host}>
        <View style={{ flex: 1 }}>
          <View testID="list-root" style={grow}>
            <If
              when={props.mode === "pending"}
              else={
                <ChatList
                  layout="phone"
                  selected=""
                  onConversation={noop}
                  onCreate={noop}
                  onArchived={noop}
                />
              }
            >
              <Pending
                layout="phone"
                onTask={noop}
                onRoutines={noop}
                onConversation={noop}
              />
            </If>
          </View>
          <If when={props.showRefs}>
            <View
              testID="time-refs"
              style={{
                alignItems: "flex-start",
                paddingHorizontal: space[16],
                paddingVertical: space[4],
              }}
            >
              <Each of={[...times]}>
                {(at) => (
                  <Label variant="caption" tone="muted" lines={1}>
                    {relativeTime(at())}
                  </Label>
                )}
              </Each>
            </View>
          </If>
        </View>
      </Host.Provider>
    </Screen.Provider>
  );
}

void Promise.all([Storage.getItem("mode"), Storage.getItem("refs")]).then(
  ([mode, refs]) =>
    mount(() => <Fixture mode={mode ?? "groups"} showRefs={refs === "1"} />),
);
