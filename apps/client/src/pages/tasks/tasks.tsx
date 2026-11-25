import type {
  AgentView,
  BoardTaskStatus,
  BoardTaskView,
} from "@eta/client-contracts";
import type { JSX, Signal } from "nsh";
import type { Layout } from "../../components";
import type { EmptyAction } from "../../components/empty-state";
import type { LoadState } from "../../services/load-status";
import { computed, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Header,
  Icon,
  Label,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { EmptyState } from "../../components/empty-state";
import { foldNext } from "../../components/motion";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { taskDropZones } from "./drag";
import { PhoneTaskList, TabletTaskList } from "./list";
import { FilterTrigger, TaskMenu, TaskMenuItem, TaskMenuRule } from "./menu";
import { Segmented } from "./segmented";
import { TaskListSkeleton } from "./skeleton";
import { TaskGlyph } from "./status";
import { ViewMenu } from "./view-menu";
import { TaskWorkspaceBoard } from "./workspace-board";
import { TaskWorkspaceList } from "./workspace-list";

const taskViews = {
  Board: "boardView",
  List: "listView",
  Plan: "plan",
} as const;

/** The header's search box; the Part of and Executor filter menus; the archive's column. */
const searchWidth = 152;
const menuWidth = { partOf: 220, executor: 200 } as const;
const archiveWidth = 916;

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
  const type = textFaces();
  follow(() => "tasks");
  const boardDrag = taskDropZones<BoardTaskStatus>((id, status) => {
    const task = host.tasks().find((item) => item.id === id);
    if (task && !task.subtasks && task.status !== status) {
      // The card lands in its column at once (#380); a refused move puts it back.
      void host.action(() =>
        host.optimistic(id, { status }, () =>
          host.call("tasks", "update", { taskId: id, status }),
        ),
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
  // Read by every row, card and plan below: filtered once per change, not on each read.
  const filtered = computed(() => {
    const words = query().trim().toLowerCase();
    return shown().filter(
      (task) =>
        (!executor() ||
          (task.assigneeAgentId ?? task.createdBy.agentId) === executor()) &&
        (!part() || task.parentId === part() || task.id === part()) &&
        `${task.title} #${task.number}`.toLowerCase().includes(words),
    );
  });
  const groupByParent = () =>
    view() === "List" &&
    !archive() &&
    (props.layout !== "desktop" || listGrouping() === "Part of");
  const collapse = (status: string) => {
    foldNext();
    expanded.update((items) =>
      items.includes(status)
        ? items.filter((entry) => entry !== status)
        : [...items, status],
    );
  };
  const load = useLoadState({ targets: () => ["tasks"] });
  /** Clear what hid every task: the search, the filters, or both. */
  const noMatchActions = (): EmptyAction[] =>
    [
      query().trim()
        ? { label: uiText("clearSearch"), onPress: () => query.set("") }
        : undefined,
      executor() || part()
        ? {
            label: uiText("clearFilters"),
            onPress: () => {
              executor.set("");
              part.set("");
            },
          }
        : undefined,
    ].filter((action) => action !== undefined);
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <If
        when={!props.condensed}
        else={
          <Header
            title={uiText("tasks2")}
            count={shown().length}
            layout={props.layout}
            inset={space[16]}
            end={space[12]}
            countVariant="body"
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
                    width: space[24],
                    height: space[24],
                    cursor: "pointer",
                    backgroundColor:
                      filterOpen() || executor() ? c().selected : undefined,
                  }}
                >
                  <Icon name="funnel" size={icon.md} />
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
          inset={tablet() ? space[16] : undefined}
          end={phone() ? space[8] : undefined}
        >
          <If when={phone()}>
            <View style={{ flex: 1 }} />
            <ViewMenu phone />
          </If>
          <If when={!phone()}>
            <If when={!archive()} else={<View style={{ flex: 1 }} />}>
              <View
                style={
                  tablet()
                    ? {
                        ...row,
                        flex: 1,
                        minWidth: 0,
                        gap: space[4],
                        marginLeft: space[4],
                      }
                    : {
                        ...row,
                        width: searchWidth,
                        height: control.sm,
                        paddingHorizontal: space[8],
                        gap: space[8],
                        marginRight: space[8],
                        flexShrink: 0,
                      }
                }
              >
                <Icon name="search" size={icon.sm} tone="muted" />
                <Field
                  label={uiText("searchTasks")}
                  placeholder={uiText("search")}
                  value={query()}
                  onChange={query.set}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: control.sm,
                    paddingHorizontal: 0,
                    paddingVertical: 0,
                    borderWidth: 0,
                    backgroundColor: "transparent",
                    ...textStyle(type("small")),
                  }}
                />
                <If when={query()}>
                  <View
                    role="button"
                    accessibilityLabel={uiText("clearSearch")}
                    onPress={() => query.set("")}
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      width: space[20],
                      height: space[20],
                      alignItems: "center",
                      justifyContent: "center",
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="close" size={icon.sm} />
                  </View>
                </If>
              </View>
            </If>
            <View style={{ ...row, gap: tablet() ? space[12] : space[8] }}>
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
                  width={menuWidth.partOf}
                  caption={uiText("partOfCaption")}
                  open={partOpen()}
                  onOpenChange={partOpen.set}
                  empty={
                    parents().length ? undefined : uiText("noParentTasksYet")
                  }
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
                  <If when={parents().length}>
                    <TaskMenuRule />
                  </If>
                  <Each of={parents()} key={(task) => task.id}>
                    {(entry) => (
                      <TaskMenuItem
                        label={entry().title}
                        suffix={`#${entry().number}`}
                        leading={
                          <TaskGlyph status={entry().status} size={icon.sm} />
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
              <If when={!archive()}>
                <ViewMenu tablet={tablet()} />
              </If>
              <If
                when={
                  props.layout === "desktop" && view() === "List" && !archive()
                }
              >
                <ActionMenu
                  label={uiText("groupTasksBy")}
                  triggerStyle={{ borderWidth: 0, height: control.sm }}
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
              when={filtered().length && load.status() === "ready"}
              else={
                <EmptyState
                  size="page"
                  status={load.shown()}
                  loading={<TaskListSkeleton label={uiText("loadingTasks")} />}
                  error={{
                    title: uiText("tasksDidNotLoad"),
                    description: load.why(),
                    retry: load.retry,
                    retrying: load.retrying(),
                  }}
                  empty={
                    shown().length
                      ? {
                          title: query().trim()
                            ? uiText("noTasksMatchQuery", {
                                query: query().trim(),
                              })
                            : uiText("noTasksMatchTheFilters"),
                          actions: noMatchActions(),
                        }
                      : {
                          art: "tasks",
                          title: uiText("noTasksYet"),
                          description: uiText("noTasksYetDescription"),
                          actions: [
                            {
                              label: uiText("newTask"),
                              icon: "plus",
                              onPress: props.onCreate,
                            },
                          ],
                        }
                  }
                  announce={shown().length > 0}
                />
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
          load={load}
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
      width={menuWidth.executor}
      caption={uiText("executor")}
      align={props.align}
      open={props.open}
      onOpenChange={props.onOpenChange}
      trigger={props.trigger}
      empty={props.executors.length ? undefined : uiText("noExecutorsYet")}
    >
      <TaskMenuItem
        label={uiText("allExecutors")}
        checked={!props.value}
        onSelect={() => props.onChange("")}
      />
      <If when={props.executors.length}>
        <TaskMenuRule />
      </If>
      <Each of={props.executors} key={(agent) => agent.id}>
        {(agent) => (
          <TaskMenuItem
            label={agent().name}
            leading={<AgentFace id={agent().id} size={avatar.sm} />}
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
        height: control.sm,
        paddingHorizontal: props.tablet && !props.selected ? 0 : space[8],
        gap: space[4],
        flexShrink: 0,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : undefined,
      }}
    >
      <Icon
        name="archive"
        size={icon.sm}
        tone={props.selected ? "ink" : "muted"}
      />
      <Label variant="small" tone={props.selected ? "ink" : "muted"}>
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
  load: LoadState;
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
  const type = textFaces();
  return (
    <View
      style={{
        ...grow,
        alignSelf: props.tablet ? "stretch" : "center",
        width: props.tablet ? undefined : "100%",
        maxWidth: props.tablet ? undefined : archiveWidth,
        paddingTop: space[20],
        paddingHorizontal: props.tablet ? space[20] : 0,
        gap: space[12],
      }}
    >
      <View style={{ ...row, gap: space[8] }}>
        <View
          style={{ ...row, flex: 1, gap: space[4], alignItems: "baseline" }}
        >
          <Label weight={weight.strong}>{uiText("archivedTitle")}</Label>
          <Label variant="small" tone="muted">
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
            height: space[24],
            paddingHorizontal: space[8],
            gap: space[4],
            cursor: "pointer",
          }}
        >
          <Icon name="arrowLeft" size={icon.sm} />
          <Label variant="small">{uiText("backToBoard")}</Label>
        </View>
      </View>
      <View
        style={{
          ...row,
          height: control.lg,
          paddingHorizontal: space[12],
          gap: space[8],
          borderWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <Icon name="search" size={icon.sm} tone="muted" />
        <Field
          label={uiText("searchTitleOrNumber")}
          placeholder={uiText("searchTitleOrNumber")}
          value={props.query}
          onChange={props.onQuery}
          style={{
            flex: 1,
            minWidth: 0,
            height: control.md,
            paddingHorizontal: 0,
            paddingVertical: 0,
            borderWidth: 0,
            backgroundColor: "transparent",
            ...textStyle(type("small")),
          }}
        />
      </View>
      <View
        style={{
          ...grow,
          marginBottom: space[12],
          borderWidth: 1,
          borderColor: c().border,
        }}
      >
        <If
          when={props.items.length}
          else={
            <EmptyState
              size="page"
              status={props.load.shown()}
              loading={<TaskListSkeleton label={uiText("loadingTasks")} />}
              error={{
                title: uiText("tasksDidNotLoad"),
                description: props.load.why(),
                retry: props.load.retry,
                retrying: props.load.retrying(),
              }}
              empty={
                props.count
                  ? {
                      title: uiText("noArchivedTasksMatchQuery", {
                        query: props.query.trim(),
                      }),
                      actions: [
                        {
                          label: uiText("clearSearch"),
                          onPress: () => props.onQuery(""),
                        },
                      ],
                    }
                  : {
                      art: "archive",
                      title: uiText("noArchivedTasks"),
                      description: uiText("noArchivedTasksDescription"),
                    }
              }
              announce={props.count > 0}
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
