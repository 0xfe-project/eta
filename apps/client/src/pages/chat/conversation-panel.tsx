import type {
  ArtifactView,
  CaptainOperationView,
  ConversationInfo,
  MemberView,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import type { Layout } from "../../components";
import { Scroll, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { ModelSelect } from "../../components/model-select";
import { CloseButton } from "../../components/navigation-buttons";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskGlyph, taskNeedsAttention, TaskStatus } from "../tasks/status";
import { TaskDetail } from "../tasks/task-detail";
import { ConversationArtifacts } from "./artifacts/conversation-artifacts";
import { ConversationMembers } from "./member-list";
import { Pending } from "./pending";

export type PanelTab = "Context" | "Tasks" | "Pending" | "Artifacts";

const panelTabs = [
  ["Context", "context", "chatContext"],
  ["Tasks", "tasks", "tasks2"],
  ["Pending", "bell", "pending"],
  ["Artifacts", "panel", "chatArtifacts"],
] as const;

export function ConversationPanel(props: {
  id: string;
  layout: Layout;
  captain?: boolean;
  taskId?: string;
  drawer: boolean;
  tab: Signal<PanelTab>;
  artifactSearch: Signal<string>;
  artifactOffset: Signal<number>;
  model: Signal<string>;
  info?: ConversationInfo;
  members: MemberView[];
  group: boolean;
  memberSteps: string;
  onToggleSteps: (session: string) => void;
  onInspect: (value: { id: string; session: string }) => void;
  onInvite: () => void;
  onActions: () => void;
  onTask: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onCloseTask: () => void;
  onCloseDrawer: () => void;
  onRoutines: (id?: string) => void;
  onArtifact: (artifact: ArtifactView) => void;
  reloadArtifacts: () => void;
}) {
  const host = useHost();
  const c = colors();
  const panel = props.tab;
  const model = props.model;
  const phone = () => props.layout === "phone";
  const pending = () =>
    host.pending().filter((entry) => entry.conversationId === props.id);
  const tasks = () =>
    host.tasks().filter((entry) => entry.conversationId === props.id);
  const needsAttention = () =>
    pending().length +
    tasks().filter(taskNeedsAttention).length +
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter(
        (op) =>
          op.status === "pending" &&
          op.requiresApproval &&
          op.payload.originConversationId === props.id,
      ).length;
  return (
    <If when={props.taskId} else={<PanelTabs />}>
      <Each of={props.taskId ? [props.taskId] : []}>
        {(id) => (
          <TaskDetail
            id={id()}
            layout={props.layout}
            docked
            onClose={props.onCloseTask}
            onTask={props.onRelatedTask}
          />
        )}
      </Each>
    </If>
  );

  function PanelTabs() {
    return (
      <View style={{ ...grow, backgroundColor: c().surface }}>
        <View
          style={{
            ...row,
            justifyContent: "center",
            gap: 2,
            height: 40,
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View
            style={{
              ...row,
              gap: 2,
              padding: 2,
              backgroundColor: c().selected,
            }}
          >
            <Each of={panelTabs}>
              {(tab) => {
                const selected = () => panel() === tab()[0];
                return (
                  <View
                    role="button"
                    accessibilityLabel={uiText(tab()[2])}
                    accessibilityState={{ selected: selected() }}
                    onPress={() => panel.set(tab()[0])}
                    hoverStyle={{ backgroundColor: c().canvas }}
                    style={{
                      ...row,
                      gap: 6,
                      height: 24,
                      paddingHorizontal: 10,
                      cursor: "pointer",
                      backgroundColor: selected() ? c().canvas : c().selected,
                    }}
                  >
                    <Icon
                      name={tab()[1]}
                      size={12}
                      tone={selected() ? "ink" : "muted"}
                    />
                    <If when={selected()}>
                      <Label size={11} line={16}>
                        {uiText(tab()[2])}
                      </Label>
                    </If>
                    <If when={tab()[0] === "Pending" && needsAttention()}>
                      <Label size={11} line={16} tone="muted">
                        {needsAttention()}
                      </Label>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
          <If when={props.drawer && !phone()}>
            <CloseButton
              onPress={props.onCloseDrawer}
              style={{ position: "absolute", right: 8 }}
            />
          </If>
        </View>
        <If
          when={panel() === "Pending"}
          else={
            <Scroll style={grow} scrollbar={false}>
              <If when={props.captain && panel() === "Context"}>
                <View style={{ padding: 12, gap: 5 }}>
                  <Caption text={uiText("captainModel")} />
                  <View style={{ ...row, gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <ModelSelect
                        value={model() || host.captain()?.model || ""}
                        onChange={model.set}
                      />
                    </View>
                    <Button
                      label={uiText("saveModel")}
                      tone="primary"
                      disabled={!model()}
                      onPress={() =>
                        void host.action(async () => {
                          await host.call("captain", "setModel", {
                            model: model(),
                          });
                          model.set("");
                        })
                      }
                    />
                  </View>
                  <Label size={10} tone="muted">
                    {uiText("chooseTheModelUsedForCaptains")}
                  </Label>
                </View>
              </If>
              <If
                when={
                  panel() === "Tasks" ||
                  (panel() === "Context" && !props.captain)
                }
              >
                <View
                  style={{
                    paddingTop: 9,
                    paddingBottom: 3,
                    paddingHorizontal: 12,
                  }}
                >
                  <Caption
                    text={uiText("tasksWithCount", { length: tasks().length })}
                  />
                </View>
                <Each
                  of={panel() === "Context" ? tasks().slice(0, 6) : tasks()}
                  key={(task) => task.id}
                >
                  {(task) => (
                    <View
                      role="button"
                      onPress={() => props.onTask(task().id)}
                      hoverStyle={{ backgroundColor: c().selected }}
                      style={{
                        ...row,
                        height: 30,
                        paddingHorizontal: 12,
                        gap: 8,
                        borderBottomWidth: 1,
                        borderColor: c().border,
                        cursor: "pointer",
                      }}
                    >
                      <TaskGlyph status={task().status} size={12} />
                      <Label size={10} tone="muted">
                        {`#${task().number}`}
                      </Label>
                      <Label size={12} lines={1} style={{ flex: 1 }}>
                        {task().title}
                      </Label>
                      <TaskStatus task={task()} />
                      <Icon name="right" size={8} tone="faint" />
                    </View>
                  )}
                </Each>
                <If when={!tasks().length}>
                  <Label
                    size={12}
                    tone="muted"
                    style={{ paddingHorizontal: 12, paddingBottom: 8 }}
                  >
                    {uiText("noTasksYet")}
                  </Label>
                </If>
              </If>
              <If when={panel() === "Context" || panel() === "Artifacts"}>
                <ConversationArtifacts
                  conversationId={props.id}
                  tab={panel()}
                  search={props.artifactSearch}
                  offset={props.artifactOffset}
                  phone={phone()}
                  onOpen={props.onArtifact}
                  onTask={props.onTask}
                  reload={props.reloadArtifacts}
                />
              </If>
              <If when={panel() === "Context"}>
                <ConversationMembers
                  members={props.members}
                  group={props.group}
                  info={props.info}
                  phone={phone()}
                  expandedSession={props.memberSteps}
                  onToggleSteps={props.onToggleSteps}
                  onInspect={props.onInspect}
                  onInvite={props.onInvite}
                  onActions={props.onActions}
                />
              </If>
            </Scroll>
          }
        >
          <Pending
            conversationId={props.id}
            layout={props.layout}
            onTask={props.onTask}
            onRoutines={props.onRoutines}
          />
        </If>
      </View>
    );
  }
}
