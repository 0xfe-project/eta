import type {
  AgentView,
  BoardTaskStatus,
  BoardTaskView,
} from "@eta/client-contracts";
import type { JSX, Signal } from "nsh";
import type { Layout } from "../../components";
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
import { AgentFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import { PhoneTaskList, TabletTaskList } from "./list";
import { FilterTrigger, TaskMenu, TaskMenuItem, TaskMenuRule } from "./menu";
import { Segmented } from "./segmented";
import { TaskListSkeleton } from "./skeleton";
import { TaskGlyph } from "./status";
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
  const archivedCount = () =>
    host.list<BoardTaskView>("tasks", "archived").length;
  /** The agents that execute a task on the board, and the one picked, once each. */
  const executors = () => {
    const ids = shown().map(
      (task) => task.assigneeAgentId ?? task.createdBy.agentId,
    );
    if (executor()) ids.push(executor());
    return [...new Set(ids)].flatMap((id) => {
      const agent = id ? host.agent(id) : undefined;
      return agent ? [agent] : [];
    });
  };
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
  /** The no-tasks and no-match states, drawn larger and bolder on desktop and tablet. */
  const designed = () =>
    !phone() && !host.state().missing.tasks && !!host.state().targets.tasks;
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
            end={10}
            countSize={14}
          >
            <View style={{ flex: 1 }} />
            <ExecutorMenu
              tablet
              align="end"
              open={filterOpen()}
              onOpenChange={filterOpen.set}
              executors={executors()}
              value={executor()}
              onChange={executor.set}
              trigger={
                <View
                  accessibilityLabel={uiText("executor")}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    justifyContent: "center",
                    width: 24,
                    height: 24,
                    cursor: "pointer",
                    backgroundColor:
                      filterOpen() || executor() ? c().selected : undefined,
                  }}
                >
                  <Icon name="funnel" size={14} />
                </View>
              }
            />
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
          count={
            phone() && !shown().length
              ? undefined
              : archive()
                ? host.tasks().length
                : shown().length
          }
          layout={props.layout}
          inset={tablet() ? 14 : undefined}
        >
          <If when={!phone()}>
            <If when={!archive()} else={<View style={{ flex: 1 }} />}>
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
            </If>
            <View style={{ ...row, gap: tablet() ? 12 : 8 }}>
              <If when={!archive()}>
                <ExecutorMenu
                  tablet={tablet()}
                  open={filterOpen()}
                  onOpenChange={filterOpen.set}
                  executors={executors()}
                  value={executor()}
                  onChange={executor.set}
                  trigger={
                    <FilterTrigger
                      tablet={tablet()}
                      active={filterOpen()}
                      label={host.agent(executor())?.name ?? uiText("executor")}
                    />
                  }
                />
                <TaskMenu
                  width={220}
                  caption={uiText("partOfCaption")}
                  open={partOpen()}
                  onOpenChange={partOpen.set}
                  trigger={
                    <FilterTrigger
                      tablet={tablet()}
                      active={partOpen()}
                      label={uiText("partOf", {
                        value1:
                          parents().find((entry) => entry.id === part())
                            ?.title ?? uiText("allItems"),
                      })}
                    />
                  }
                >
                  <TaskMenuItem
                    label={uiText("allItems")}
                    checked={!part()}
                    onSelect={() => part.set("")}
                  />
                  <TaskMenuRule />
                  <Each of={parents()} key={(task) => task.id}>
                    {(entry) => (
                      <TaskMenuItem
                        label={entry().title}
                        suffix={`#${entry().number}`}
                        leading={
                          <TaskGlyph status={entry().status} size={12} />
                        }
                        checked={part() === entry().id}
                        onSelect={() => part.set(entry().id)}
                      />
                    )}
                  </Each>
                </TaskMenu>
              </If>
              <ArchiveToggle
                tablet={tablet()}
                label={uiText("archived", {
                  length: archivedCount(),
                })}
                selected={archive()}
                onPress={() => {
                  query.set("");
                  archive.set(!archive());
                }}
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
              <If when={!archive()}>
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
              </If>
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
      <If
        when={archive() && !phone() && !props.condensed}
        else={
          <>
            <If
              when={filtered().length}
              else={
                <If
                  when={
                    host.state().missing.tasks || host.state().targets.tasks
                  }
                  else={<TaskListSkeleton label={uiText("loadingTasks")} />}
                >
                  <Empty
                    style={
                      host.state().missing.tasks || !host.state().targets.tasks
                        ? undefined
                        : phone()
                          ? { gap: 10, paddingHorizontal: 40 }
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
                    icon={host.state().missing.tasks ? "warning" : "tasks"}
                    iconSize={
                      host.state().missing.tasks
                        ? 32
                        : designed()
                          ? 28
                          : undefined
                    }
                    iconTone={
                      host.state().missing.tasks
                        ? "red"
                        : designed() && tablet()
                          ? "ink"
                          : undefined
                    }
                    titleSize={designed() && tablet() ? 13 : undefined}
                    titleLine={designed() && tablet() ? 16 : undefined}
                    titleWeight={designed() ? 600 : undefined}
                    titleTone={designed() ? "ink" : undefined}
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
                        size={28}
                        style={{ marginTop: 4 }}
                        onPress={host.retry}
                      />
                    </If>
                  </Empty>
                </If>
              }
            >
              <If
                when={!phone() && !props.condensed}
                else={
                  <If
                    when={props.condensed}
                    else={
                      <PhoneTaskList tasks={filtered()} onOpen={props.onOpen} />
                    }
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
          </>
        }
      >
        <ArchivedTasks
          tablet={tablet()}
          count={archivedCount()}
          items={shown().filter((task) =>
            `${task.title} #${task.number}`
              .toLowerCase()
              .includes(query().trim().toLowerCase()),
          )}
          query={query()}
          onQuery={query.set}
          expanded={expanded()}
          foldedParents={foldedParents}
          onFoldStatus={collapse}
          onBack={() => {
            query.set("");
            archive.set(false);
          }}
          onOpen={props.onOpen}
          layout={props.layout}
        />
      </If>
    </View>
  );
}

/** The Executor filter: every agent that executes a task on the board. */
function ExecutorMenu(props: {
  tablet: boolean;
  align?: "start" | "end";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  executors: AgentView[];
  value: string;
  onChange: (id: string) => void;
  trigger: JSX.Element;
}) {
  return (
    <TaskMenu
      width={200}
      caption={uiText("executor")}
      align={props.align}
      open={props.open}
      onOpenChange={props.onOpenChange}
      trigger={props.trigger}
    >
      <TaskMenuItem
        label={uiText("allExecutors")}
        checked={!props.value}
        onSelect={() => props.onChange("")}
      />
      <TaskMenuRule />
      <Each of={props.executors} key={(agent) => agent.id}>
        {(agent) => (
          <TaskMenuItem
            label={agent().name}
            leading={<AgentFace id={agent().id} size={10} />}
            checked={props.value === agent().id}
            onSelect={() => props.onChange(agent().id)}
          />
        )}
      </Each>
    </TaskMenu>
  );
}

/** The header's Archived toggle: muted until it is on, then ink on a muted fill. */
function ArchiveToggle(props: {
  label: string;
  tablet: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 25,
        paddingHorizontal: props.tablet && !props.selected ? 0 : 8,
        gap: 4,
        flexShrink: 0,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : undefined,
      }}
    >
      <Icon
        name="archive"
        size={props.selected ? 13 : 12}
        tone={props.selected ? "ink" : "muted"}
      />
      <Label size={12} line={16} tone={props.selected ? "ink" : "muted"}>
        {props.label}
      </Label>
    </View>
  );
}

/**
 * The Archived view in place of the board: its title with the way back, a
 * search over the archive, and the archived tasks (or why there are none) in a
 * bordered box. A 916px column on desktop, the full width on tablet.
 */
function ArchivedTasks(props: {
  layout: Layout;
  tablet: boolean;
  count: number;
  items: BoardTaskView[];
  query: string;
  expanded: string[];
  foldedParents: Signal<string[]>;
  onQuery: (value: string) => void;
  onFoldStatus: (status: string) => void;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...grow,
        alignSelf: props.tablet ? "stretch" : "center",
        width: props.tablet ? undefined : "100%",
        maxWidth: props.tablet ? undefined : 916,
        paddingTop: 20,
        paddingHorizontal: props.tablet ? 20 : 0,
        gap: 12,
      }}
    >
      <View style={{ ...row, gap: 8 }}>
        <View style={{ ...row, flex: 1, gap: 6, alignItems: "baseline" }}>
          <Label size={14} line={18} weight={600}>
            {uiText("archivedTitle")}
          </Label>
          <Label size={12} line={16} tone="muted">
            {props.count}
          </Label>
        </View>
        <View
          role="button"
          accessibilityLabel={uiText("backToBoard")}
          onPress={props.onBack}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            height: 24,
            paddingHorizontal: 6,
            gap: 4,
            cursor: "pointer",
          }}
        >
          <Icon name="arrowLeft" size={12} />
          <Label size={12} line={16}>
            {uiText("backToBoard")}
          </Label>
        </View>
      </View>
      <View
        style={{
          ...row,
          height: 30,
          paddingHorizontal: 10,
          gap: 8,
          borderWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <Icon name="search" size={12} tone="muted" />
        <Field
          label={uiText("searchTitleOrNumber")}
          placeholder={uiText("searchTitleOrNumber")}
          value={props.query}
          onChange={props.onQuery}
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            paddingHorizontal: 0,
            paddingVertical: 0,
            borderWidth: 0,
            backgroundColor: "transparent",
            fontSize: 12,
            lineHeight: 16,
          }}
        />
      </View>
      <View
        style={{
          ...grow,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: c().border,
        }}
      >
        <If
          when={props.items.length}
          else={
            <Empty
              icon="archive"
              iconSize={28}
              title={
                props.count
                  ? uiText("noArchivedTasksMatch")
                  : uiText("noArchivedTasks")
              }
              titleWeight={600}
              titleTone="ink"
              description={
                props.count ? undefined : uiText("noArchivedTasksDescription")
              }
              descriptionWidth={props.tablet ? 420 : 448}
              style={{
                flex: 1,
                justifyContent: "flex-start",
                paddingTop: 64,
                gap: 10,
              }}
            />
          }
        >
          <TaskWorkspaceList
            layout={props.layout}
            view="List"
            items={props.items}
            groupByParent={false}
            foldedParents={props.foldedParents}
            expanded={props.expanded}
            onFoldStatus={props.onFoldStatus}
            onOpen={props.onOpen}
          />
        </If>
      </View>
    </View>
  );
}
