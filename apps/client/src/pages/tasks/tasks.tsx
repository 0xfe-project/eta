import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { IconName } from "../../components/icons";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  Field,
  grow,
  Header,
  Icon,
  Label,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import { PhoneTaskList, TabletTaskList } from "./list";
import { Segmented } from "./segmented";
import { TaskWorkspaceBoard } from "./workspace-board";
import { TaskWorkspaceList } from "./workspace-list";

const taskViews = {
  Board: "boardView",
  List: "listView",
  Plan: "plan",
} as const;

export function Tasks(props: {
  layout: Layout;
  condensed?: boolean;
  /** The task open beside the list, highlighted in it. */
  selected?: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const host = useHost();
  const c = colors();
  follow(() => "tasks");
  const boardDrag = taskDropZones<BoardTaskStatus>((id, status) => {
    const task = host.tasks().find((item) => item.id === id);
    if (task && !task.subtasks && task.status !== status) {
      void host.action(() =>
        host.call("tasks", "update", { taskId: id, status }),
      );
    }
  });
  const view = signal<keyof typeof taskViews>("Board");
  const listGrouping = signal<"Part of" | "Status">("Part of");
  const foldedParents = signal<string[]>([]);
  const query = signal("");
  const archive = signal(false);
  const executor = signal("");
  const filterOpen = signal(false);
  const expanded = signal<string[]>([]);
  const part = signal("");
  const partOpen = signal(false);
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const shown = () =>
    archive() ? host.list<BoardTaskView>("tasks", "archived") : host.tasks();
  const parents = () => shown().filter((entry) => entry.subtasks?.total);
  const filtered = () =>
    shown().filter(
      (task) =>
        (!executor() ||
          (task.assigneeAgentId ?? task.createdBy.agentId) === executor()) &&
        (!part() || task.parentId === part() || task.id === part()) &&
        `${task.title} #${task.number}`
          .toLowerCase()
          .includes(query().trim().toLowerCase()),
    );
  const groupByParent = () =>
    view() === "List" &&
    !archive() &&
    (props.layout !== "desktop" || listGrouping() === "Part of");
  const collapse = (status: string) =>
    expanded.update((items) =>
      items.includes(status)
        ? items.filter((entry) => entry !== status)
        : [...items, status],
    );
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={!props.condensed}
        else={
          <Header
            title={uiText("tasks2")}
            count={shown().length}
            layout={props.layout}
            inset={14}
          >
            <View style={{ flex: 1 }} />
            <Button
              label={uiText("new")}
              icon="plus"
              iconOnly
              onPress={props.onCreate}
            />
          </Header>
        }
      >
        <Header
          title={uiText("tasks2")}
          count={shown().length}
          layout={props.layout}
          inset={tablet() ? 14 : undefined}
        >
          <If when={!phone()}>
            <View
              style={
                tablet()
                  ? { ...row, flex: 1, minWidth: 0, gap: 6, marginLeft: 4 }
                  : {
                      ...row,
                      width: 150,
                      height: 25,
                      paddingHorizontal: 8,
                      gap: 7,
                      marginRight: 7,
                      flexShrink: 0,
                    }
              }
            >
              <Icon name="search" size={tablet() ? 12 : 12.6} tone="muted" />
              <Field
                label={uiText("searchTasks")}
                placeholder={uiText("search")}
                value={query()}
                onChange={query.set}
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 25,
                  paddingHorizontal: 0,
                  paddingVertical: 0,
                  borderWidth: 0,
                  backgroundColor: "transparent",
                  fontSize: 12,
                  lineHeight: 16,
                }}
              />
              <If when={query()}>
                <View
                  role="button"
                  accessibilityLabel={uiText("clearSearch")}
                  onPress={() => query.set("")}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    width: 20,
                    height: 20,
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                  }}
                >
                  <Icon name="close" size={10} />
                </View>
              </If>
            </View>
            <View style={{ ...row, gap: tablet() ? 12 : 8 }}>
              <HeaderFilter
                tablet={tablet()}
                label={host.agent(executor())?.name ?? uiText("executor")}
                end="down"
                onPress={() => filterOpen.set(!filterOpen())}
              />
              <HeaderFilter
                tablet={tablet()}
                label={uiText("partOf", {
                  value1:
                    parents().find((entry) => entry.id === part())?.title ??
                    uiText("allItems"),
                })}
                end="down"
                onPress={() => partOpen.set(!partOpen())}
              />
              <HeaderFilter
                tablet={tablet()}
                label={uiText("archived", {
                  length: host.list<BoardTaskView>("tasks", "archived").length,
                })}
                icon="archive"
                selected={archive()}
                onPress={() => archive.set(!archive())}
              />
              <If
                when={
                  props.layout === "desktop" && view() === "List" && !archive()
                }
              >
                <ActionMenu
                  label={uiText("groupTasksBy")}
                  triggerStyle={{ borderWidth: 0, height: 25 }}
                  value={uiText("taskGrouping", {
                    name: uiText(
                      listGrouping() === "Part of" ? "groupByPartOf" : "status",
                    ),
                  })}
                >
                  <Each of={["Part of", "Status"] as const}>
                    {(mode) => (
                      <ActionItem
                        label={uiText(
                          mode() === "Part of" ? "groupByPartOf" : "status",
                        )}
                        checked={listGrouping() === mode()}
                        onSelect={() => listGrouping.set(mode())}
                      />
                    )}
                  </Each>
                </ActionMenu>
              </If>
              <Segmented
                options={(["Board", "List", "Plan"] as const).map((mode) => ({
                  value: mode,
                  label: uiText(taskViews[mode]),
                }))}
                value={view()}
                strong={tablet()}
                paddingHorizontal={tablet() ? 8 : undefined}
                onChange={view.set}
              />
              <Button
                label={uiText("new")}
                tone="primary"
                icon="plus"
                onPress={props.onCreate}
              />
            </View>
          </If>
        </Header>
      </If>
      <If when={partOpen()}>
        <View style={{ ...row, padding: 8, gap: 6 }}>
          <Button
            label={uiText("allTasks")}
            selected={!part()}
            onPress={() => {
              part.set("");
              partOpen.set(false);
            }}
          />
          <Each of={parents()} key={(task) => task.id}>
            {(entry) => (
              <Button
                label={entry().title}
                selected={part() === entry().id}
                onPress={() => {
                  part.set(entry().id);
                  partOpen.set(false);
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If when={filterOpen()}>
        <View style={{ ...row, padding: 8, gap: 6 }}>
          <Button
            label={uiText("allExecutors")}
            selected={!executor()}
            onPress={() => {
              executor.set("");
              filterOpen.set(false);
            }}
          />
          <Each of={host.people()} key={(agent) => agent.id}>
            {(agent) => (
              <Button
                label={agent().name}
                selected={executor() === agent().id}
                onPress={() => {
                  executor.set(agent().id);
                  filterOpen.set(false);
                }}
              />
            )}
          </Each>
        </View>
      </If>
      <If
        when={filtered().length}
        else={
          <Empty
            style={
              host.state().missing.tasks || !host.state().targets.tasks
                ? undefined
                : {
                    flex: 1,
                    justifyContent: "flex-start",
                    paddingTop: 64,
                    gap: tablet() ? 8 : 10,
                  }
            }
            title={
              host.state().missing.tasks
                ? uiText("unableToLoadTasks")
                : !host.state().targets.tasks
                  ? uiText("loadingTasks")
                  : shown().length
                    ? uiText("noTasksMatchTheFilters")
                    : uiText("noTasksYet")
            }
            icon={host.state().missing.tasks ? "info" : "tasks"}
            description={
              host.state().missing.tasks
                ? uiText("theHostDidNotRespondIn")
                : host.state().targets.tasks && !shown().length
                  ? uiText("noTasksYetDescription")
                  : undefined
            }
          >
            <If when={host.state().missing.tasks}>
              <Button
                label={uiText("retry")}
                icon="refresh"
                onPress={host.retry}
              />
            </If>
          </Empty>
        }
      >
        <If
          when={!phone() && !props.condensed}
          else={
            <If
              when={props.condensed}
              else={<PhoneTaskList tasks={filtered()} onOpen={props.onOpen} />}
            >
              <TabletTaskList
                tasks={filtered()}
                selected={props.selected}
                onOpen={props.onOpen}
              />
            </If>
          }
        >
          <If
            when={view() === "Board" && !archive()}
            else={
              <TaskWorkspaceList
                layout={props.layout}
                view={view()}
                items={filtered()}
                groupByParent={groupByParent()}
                foldedParents={foldedParents}
                expanded={expanded()}
                onFoldStatus={collapse}
                onOpen={props.onOpen}
              />
            }
          >
            <TaskWorkspaceBoard
              items={filtered()}
              expanded={expanded()}
              drag={boardDrag}
              layout={props.layout}
              onFoldStatus={collapse}
              onOpen={props.onOpen}
            />
          </If>
        </If>
      </If>
    </View>
  );
}

/** A filter in the page header: a ghost button on desktop, plain muted text on tablet. */
function HeaderFilter(props: {
  label: string;
  tablet: boolean;
  icon?: IconName;
  end?: IconName;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <If
      when={props.tablet}
      else={
        <Button
          label={props.label}
          icon={props.icon}
          end={props.end}
          tone="ghost"
          selected={props.selected}
          onPress={props.onPress}
        />
      }
    >
      <View
        role="button"
        accessibilityLabel={props.label}
        accessibilityState={{ selected: props.selected }}
        onPress={props.onPress}
        style={{ ...row, gap: 4, flexShrink: 0, cursor: "pointer" }}
      >
        <If when={props.icon}>
          {(icon) => <Icon name={icon()} size={12} tone="muted" />}
        </If>
        <Label
          size={12}
          line={16}
          weight={props.icon ? (props.selected ? 600 : 400) : 500}
          tone={props.selected ? "ink" : "muted"}
        >
          {props.label}
        </Label>
        <If when={props.end}>
          {(end) => <Icon name={end()} size={10} tone="muted" />}
        </If>
      </View>
    </If>
  );
}
