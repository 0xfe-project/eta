import type { BoardTaskView, ConversationSummary } from "@eta/client-contracts";
import { mount, signal, Text, View } from "nsh";
import { NewTask } from "../../src/pages/tasks/new-task";
import { createHost, Host } from "../../src/services/host";

// New task dialog with two agents (Ada, Lin), one group containing only Lin,
// and one parent task belonging to that group.
const now = Date.now();

const designGroup = {
  id: "grp-lin",
  projectId: "proj-1",
  kind: "group",
  name: "Design",
  archived: false,
  stewardId: null,
  participants: [
    { agentId: "lin", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 0,
  readSeq: 0,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: now,
  updatedAt: now,
} as unknown as ConversationSummary;

const designParent = {
  id: "parent-1",
  number: 7,
  title: "Design pass",
  status: "todo",
  createdBy: { kind: "agent", agentId: "lin" },
  assigneeAgentId: "lin",
  conversationId: "grp-lin",
  runStatus: null,
  comments: 0,
  createdAt: now,
  updatedAt: now,
} as unknown as BoardTaskView;

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
            { id: "lin", name: "Lin" },
          ],
        },
      },
      conversations: {
        version: 1,
        revisions: {},
        sections: { list: [designGroup] },
      },
      tasks: {
        version: 1,
        revisions: {},
        sections: { list: [designParent] },
      },
    },
  }));
  const calls = signal<string[]>([]);
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((log) => [
      ...log,
      `${target}.${action} ${JSON.stringify(args)}`,
    ]);
    return undefined as T;
  };
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Calls: ${calls().join(", ")}`}</Text>
        <NewTask phone={false} onOpen={() => {}} onClose={() => {}} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
