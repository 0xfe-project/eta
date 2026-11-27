import type { BoardTaskView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Compact } from "../../src/components";
import { ConversationArtifacts } from "../../src/pages/chat/artifacts/conversation-artifacts";
import { defaultFilters } from "../../src/pages/chat/artifacts/filter";
import { ConversationMembers } from "../../src/pages/chat/member-list";
import { ContextTasks } from "../../src/pages/chat/panel-tasks";
import { createHost, Host } from "../../src/services/host";

const doneTask: BoardTaskView = {
  id: "t1",
  number: 1,
  title: "Finished task",
  status: "done",
  createdBy: { kind: "user" },
  assigneeAgentId: null,
  conversationId: "group",
  runStatus: null,
  comments: 0,
  createdAt: 0,
  updatedAt: 0,
} as unknown as BoardTaskView;

function Fixture() {
  const host = createHost();
  const list = <T,>(items: T[]) => ({
    sections: { list: items },
    revisions: {},
    version: 0,
  });
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      tasks: list([doneTask]),
      artifacts: list([]),
    },
  }));
  const noop = () => {};
  const artifactFilters = signal(defaultFilters);

  return (
    <Host.Provider value={host}>
      <Compact>
        <View style={{ width: 360 }}>
          <View testID="context-tasks-empty">
            <ContextTasks tasks={[]} onTask={noop} onViewAll={noop} />
          </View>
          <View testID="context-tasks-no-open">
            <ContextTasks tasks={[doneTask]} onTask={noop} onViewAll={noop} />
          </View>
          <View testID="context-artifacts-empty">
            <ConversationArtifacts
              conversationId="group"
              tab="Context"
              filters={artifactFilters}
              phone={false}
              onOpen={noop}
              onTask={noop}
              onViewAll={noop}
              reload={noop}
            />
          </View>
          <View testID="context-members-empty">
            <ConversationMembers
              members={[]}
              group={false}
              expandedSession=""
              onToggleSteps={noop}
              onInspect={noop}
              onInvite={noop}
              onRemove={noop}
            />
          </View>
        </View>
      </Compact>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
