import type {
  ArtifactView,
  CaptainOperationView,
  ConversationInfo,
  MemberView,
} from "@eta/client-contracts";
import type { Signal } from "nsh";
import type { Layout } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import { signal, View } from "nsh";
import {
  Button,
  Caption,
  colors,
  Compact,
  focusRing,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { ModelSelect } from "../../components/model-select";
import { CloseButton } from "../../components/navigation-buttons";
import { icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskNeedsAttention } from "../tasks/status";
import { Proposal } from "./approvals";
import { ConversationArtifacts } from "./artifacts/conversation-artifacts";
import { ConversationMembers } from "./member-list";
import { PanelTask } from "./panel-task";
import { ContextTasks, TasksTab } from "./panel-tasks";
import { Pending } from "./pending";

export type PanelTab = "Context" | "Tasks" | "Pending" | "Artifacts";

const panelTabs = [
  ["Context", "context", "chatContext"],
  ["Tasks", "tasks", "tasks2"],
  ["Pending", "bell", "pending"],
  ["Artifacts", "panel", "chatArtifacts"],
] as const;

/** How many things in a conversation wait for the user: the Pending tab count. */
export function panelAttention(host: ReturnType<typeof useHost>, id: string) {
  return (
    host.pending().filter((entry) => entry.conversationId === id).length +
    host
      .tasks()
      .filter((entry) => entry.conversationId === id)
      .filter(taskNeedsAttention).length +
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter(
        (op) =>
          op.status === "pending" &&
          op.requiresApproval &&
          op.payload.originConversationId === id,
      ).length
  );
}

export function ConversationPanel(props: {
  id: string;
  layout: Layout;
  captain?: boolean;
  taskId?: string;
  drawer: boolean;
  tab: Signal<PanelTab>;
  artifactFilters: Signal<ArtifactFilters>;
  model: Signal<string>;
  info?: ConversationInfo;
  members: MemberView[];
  group: boolean;
  memberSteps: string;
  onToggleSteps: (session: string) => void;
  onInspect: (value: { id: string; session: string }) => void;
  onInvite: () => void;
  onRemove: (agentId: string) => void;
  onTask: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onCloseTask: () => void;
  onCloseDrawer: () => void;
  onRoutines: (id?: string) => void;
  onArtifact: (artifact: ArtifactView, version?: number) => void;
  reloadArtifacts: () => void;
}) {
  const host = useHost();
  const c = colors();
  const panel = props.tab;
  const model = props.model;
  const savingModel = signal(false);
  const phone = () => props.layout === "phone";
  const tasks = () =>
    host.tasks().filter((entry) => entry.conversationId === props.id);
  const needsAttention = () => panelAttention(host, props.id);
  const artifactCount = () =>
    host.artifacts().filter((entry) => entry.conversationId === props.id)
      .length;
  /** The tablet drawer: tabs start at the left, the close button sits at the right. */
  const docked = () => props.drawer && !phone();
  const approvals = () =>
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter((op) => op.status === "pending" && op.requiresApproval);
  return <PanelTabs />;

  function PanelTabs() {
    return (
      <Compact>
        <View style={{ ...grow, backgroundColor: c().surface }}>
          <View
            style={{
              ...row,
              justifyContent: docked() ? "space-between" : "center",
              gap: space[2],
              paddingLeft: docked() ? space[12] : 0,
              paddingRight: docked() ? space[8] : 0,
              height: space[40],
              flexShrink: 0,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View
              style={{
                ...row,
                gap: space[2],
                padding: space[2],
                backgroundColor: c().selected,
              }}
            >
              <Each of={panelTabs}>
                {(tab) => {
                  const selected = () =>
                    props.taskId ? tab()[0] === "Tasks" : panel() === tab()[0];
                  return (
                    <View
                      role="button"
                      accessibilityLabel={uiText(tab()[2])}
                      accessibilityState={{ selected: selected() }}
                      onPress={() => {
                        panel.set(tab()[0]);
                        if (props.taskId) props.onCloseTask();
                      }}
                      hoverStyle={{ backgroundColor: c().canvas }}
                      focusVisibleStyle={focusRing(c())}
                      style={{
                        ...row,
                        gap: space[4],
                        height: space[24],
                        paddingHorizontal: space[12],
                        cursor: "pointer",
                        backgroundColor: selected() ? c().canvas : c().selected,
                      }}
                    >
                      <Icon
                        name={tab()[1]}
                        size={icon.sm}
                        tone={selected() ? "ink" : "muted"}
                      />
                      <If when={selected()}>
                        <Label variant="small">{uiText(tab()[2])}</Label>
                      </If>
                      <If when={tab()[0] === "Pending" && needsAttention()}>
                        <Label variant="small" tone="muted">
                          {needsAttention()}
                        </Label>
                      </If>
                      <If
                        when={
                          tab()[0] === "Artifacts" &&
                          selected() &&
                          artifactCount()
                        }
                      >
                        <Label variant="small" tone="muted">
                          {artifactCount()}
                        </Label>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
            <If when={docked()}>
              <CloseButton
                iconSize={icon.sm}
                style={{ backgroundColor: "transparent" }}
                onPress={props.onCloseDrawer}
              />
            </If>
          </View>
          <If when={props.taskId}>
            {(id) => (
              // Keyed by the task: a related task opened from this one is a new detail, not this one renamed.
              <Each of={[id()]}>
                {(task) => (
                  <PanelTask
                    id={task()}
                    layout={props.layout}
                    onClose={props.onCloseTask}
                    onTask={props.onRelatedTask}
                    onArtifact={props.onArtifact}
                  />
                )}
              </Each>
            )}
          </If>
          <If
            when={!props.taskId && panel() === "Pending"}
            else={
              <If when={!props.taskId}>
                <If
                  when={panel() === "Artifacts"}
                  else={
                    <SmoothScroll style={grow} scrollbar={false}>
                      <If when={props.captain && panel() === "Context"}>
                        <View
                          style={{
                            padding: space[12],
                            gap: space[4],
                            borderBottomWidth: 1,
                            borderColor: c().border,
                          }}
                        >
                          <Caption text={uiText("captainModel")} />
                          <View style={{ ...row, gap: space[8] }}>
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
                              busy={savingModel()}
                              onPress={() => {
                                if (savingModel() || !model()) return;
                                savingModel.set(true);
                                void host
                                  .action(async () => {
                                    await host.call("captain", "setModel", {
                                      model: model(),
                                    });
                                    model.set("");
                                  })
                                  .finally(() => savingModel.set(false));
                              }}
                            />
                          </View>
                          <Label variant="caption" tone="muted">
                            {uiText("chooseTheModelUsedForCaptains")}
                          </Label>
                        </View>
                        <View
                          style={{
                            padding: space[12],
                            gap: space[4],
                            borderBottomWidth: 1,
                            borderColor: c().border,
                          }}
                        >
                          <Caption
                            text={uiText("pendingApprovals", {
                              count: approvals().length,
                            })}
                          />
                          <If
                            when={approvals().length}
                            else={
                              <EmptyState
                                size="row"
                                status="empty"
                                loading={null}
                                error={null}
                                empty={{
                                  title: uiText("nothingIsWaitingForApproval"),
                                }}
                                style={{ paddingHorizontal: 0 }}
                              />
                            }
                          >
                            <Each of={approvals()} key={(op) => op.id}>
                              {(op) => <Proposal operation={op()} />}
                            </Each>
                          </If>
                        </View>
                      </If>
                      <If when={panel() === "Context" && !props.captain}>
                        <ContextTasks
                          tasks={tasks()}
                          onTask={props.onTask}
                          onViewAll={() => panel.set("Tasks")}
                        />
                      </If>
                      <If when={panel() === "Tasks"}>
                        <TasksTab
                          conversationId={props.id}
                          onTask={props.onTask}
                        />
                      </If>
                      <If when={panel() === "Context"}>
                        <ConversationArtifacts
                          conversationId={props.id}
                          tab={panel()}
                          filters={props.artifactFilters}
                          onViewAll={() => panel.set("Artifacts")}
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
                          expandedSession={props.memberSteps}
                          onToggleSteps={props.onToggleSteps}
                          onInspect={props.onInspect}
                          onInvite={props.onInvite}
                          onRemove={props.onRemove}
                        />
                      </If>
                    </SmoothScroll>
                  }
                >
                  {/* The Artifacts tab scrolls its list between the filters and the pages. */}
                  <ConversationArtifacts
                    conversationId={props.id}
                    tab={panel()}
                    filters={props.artifactFilters}
                    phone={phone()}
                    onOpen={props.onArtifact}
                    onTask={props.onTask}
                    reload={props.reloadArtifacts}
                  />
                </If>
              </If>
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
      </Compact>
    );
  }
}
