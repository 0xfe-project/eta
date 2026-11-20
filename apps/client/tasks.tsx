import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskActivityView,
  TaskResults,
  TaskRunView,
} from "@eta/client-contracts";
import type { PanEvent, Point, PressEvent, ViewRef } from "nsh";
import type { Layout } from "./ui";
import { dependencyEntry, TASK_STATUSES } from "@eta/client-contracts";
import { computed, Image, Scroll, signal, View, windowSize } from "nsh";
import { follow, relativeTime, useHost } from "./host";
import { uiText } from "./locale";
import { MemberRun } from "./member-run";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Empty,
  Field,
  grow,
  Header,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
} from "./ui";

const statusKeys = {
  backlog: "backlog",
  todo: "taskToDo",
  in_progress: "taskInProgress",
  in_review: "taskInReview",
  done: "taskCompleted",
  blocked: "taskBlocked",
  cancelled: "taskCancelled",
} as const satisfies Record<BoardTaskStatus, Parameters<typeof uiText>[0]>;

function statusName(status: BoardTaskStatus) {
  return uiText(statusKeys[status]);
}
const taskViews = {
  Board: "boardView",
  List: "listView",
  Plan: "plan",
} as const;
const mainStatuses: BoardTaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
];
const visibleStatuses: BoardTaskStatus[] = [
  ...mainStatuses,
  "backlog",
  "cancelled",
];
const tones = {
  backlog: "faint",
  todo: "ink",
  in_progress: "blue",
  in_review: "amber",
  blocked: "red",
  done: "green",
  cancelled: "muted",
} as const;
const statusShapes: Record<BoardTaskStatus, string> = {
  backlog:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-dasharray="2 2"/>',
  todo: '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  in_progress:
    '<circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5a6.5 6.5 0 010 13z" fill="currentColor"/>',
  in_review:
    '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M3.6 8C5.2 5.2 10.8 5.2 12.4 8 10.8 10.8 5.2 10.8 3.6 8Z" fill="paper"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  blocked:
    '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.5 8h7" stroke="white" stroke-width="1.8"/>',
  done: '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.8 8.2 7 10.4l4.2-4.6" fill="none" stroke="white" stroke-width="1.6"/>',
  cancelled:
    '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="m5.5 5.5 5 5m0-5-5 5" stroke="white" stroke-width="1.4"/>',
};

export function taskNeedsAttention(task: BoardTaskView): boolean {
  return (
    !task.archivedAt &&
    ((task.status === "in_review" && !task.subtasks?.total) ||
      (task.status === "blocked" &&
        !!task.waitingOn?.some((edge) => edge.state === "cancelled")))
  );
}

export function TaskGlyph(props: { status: BoardTaskStatus; size?: number }) {
  const c = colors();
  const src = () => {
    const shape = statusShapes[props.status]
      .replaceAll("currentColor", c()[tones[props.status]])
      .replaceAll("paper", c().canvas);
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${shape}</svg>`)}`;
  };
  return (
    <Image
      src={src()}
      fadeDuration={0}
      style={{
        width: props.size ?? 12.6,
        height: props.size ?? 12.6,
        flexShrink: 0,
      }}
    />
  );
}

export function TaskStatus(props: { task: BoardTaskView }) {
  const c = colors();
  const waiting = () =>
    props.task.waitingOn?.length && props.task.status === "todo";
  const fill = () =>
    props.task.status === "in_progress"
      ? c().blueFill
      : props.task.status === "in_review"
        ? c().amberFill
        : props.task.status === "done"
          ? c().greenFill
          : props.task.status === "blocked"
            ? c().redFill
            : c().selected;
  return (
    <View
      style={{
        ...row,
        height: 22,
        paddingHorizontal: 5,
        gap: 4,
        flexShrink: 0,
        backgroundColor: waiting() ? c().canvas : fill(),
        borderWidth: waiting() ? 1 : 0,
        borderColor: c().strong,
      }}
    >
      <If when={waiting()}>
        <Icon name="lock" size={11} tone="muted" />
      </If>
      <Label
        size={12}
        line={16}
        tone={waiting() ? "muted" : tones[props.task.status]}
      >
        {waiting()
          ? uiText("waitingForPrerequisites")
          : statusName(props.task.status)}
      </Label>
    </View>
  );
}

export function TaskSummary(props: {
  task: BoardTaskView;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      onPress={() => props.onPress()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{ borderWidth: 1, borderColor: c().border, cursor: "pointer" }}
    >
      <View
        style={{
          ...row,
          paddingHorizontal: 10,
          minHeight: 36,
          gap: 8,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Icon name="right" size={8} tone="faint" />
        <TaskGlyph status={props.task.status} size={12} />
        <Caption text={uiText("taskCard")} />
        <Label size={12} tone="muted">
          {`#${props.task.number}`}
        </Label>
        <Label size={12} weight={500} lines={1} style={{ flex: 1 }}>
          {props.task.title}
        </Label>
        <TaskStatus task={props.task} />
      </View>
      <Label size={12} tone="muted" style={{ padding: 10 }}>
        {(props.task.runStatus ?? statusName(props.task.status)).replaceAll(
          "_",
          " ",
        )}
      </Label>
    </View>
  );
}

function taskDropZones<T extends string>(
  drop: (source: string, target: T) => void,
) {
  const targets = new Map<T, ViewRef>();
  const active = signal("");
  const gesture = (id: string) => {
    let origin: Point | undefined;
    return {
      onPressDown(event: PressEvent) {
        origin = event.pagePosition;
      },
      onPanStart() {
        active.set(id);
      },
      async onPanEnd(event: PanEvent) {
        const start = origin;
        origin = undefined;
        active.set("");
        if (
          !start ||
          event.cancelled ||
          Math.hypot(event.translation.x, event.translation.y) < 5
        )
          return;
        const x = start.x + event.translation.x;
        const y = start.y + event.translation.y;
        const measured = await Promise.all(
          [...targets].map(async ([key, view]) => ({
            key,
            box: await view.measure(),
          })),
        );
        const target = measured.find(
          ({ box }) =>
            box &&
            x >= box.pagePosition.x &&
            x < box.pagePosition.x + box.bounds.size.width &&
            y >= box.pagePosition.y &&
            y < box.pagePosition.y + box.bounds.size.height,
        );
        if (target) drop(id, target.key);
      },
    };
  };
  return {
    active,
    gesture,
    register: (key: T, view: ViewRef) => targets.set(key, view),
  };
}

function BoardCard(props: {
  task: BoardTaskView;
  onOpen: () => void;
  drag: ReturnType<typeof taskDropZones<BoardTaskStatus>>;
  draggable: boolean;
}) {
  const host = useHost();
  const c = colors();
  const gesture = props.drag.gesture(props.task.id);
  const parent = () =>
    host.tasks().find((task) => task.id === props.task.parentId);
  return (
    <View
      role="button"
      accessibilityLabel={props.task.title}
      onPressDown={props.draggable ? gesture.onPressDown : undefined}
      onPanStart={props.draggable ? gesture.onPanStart : undefined}
      onPanEnd={props.draggable ? gesture.onPanEnd : undefined}
      onPress={() => props.onOpen()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        padding: 9,
        gap: 3,
        borderWidth: 1,
        borderLeftWidth: props.task.status === "blocked" ? 2 : 1,
        borderLeftColor: props.task.status === "blocked" ? c().red : c().border,
        borderColor: c().border,
        backgroundColor: c().canvas,
        cursor: props.draggable ? "grab" : "pointer",
        opacity: props.drag.active() === props.task.id ? 0.65 : 1,
      }}
    >
      <If when={parent()}>
        {(entry) => (
          <Label size={12} tone="muted" lines={1}>
            {entry().title}
          </Label>
        )}
      </If>
      <View style={{ ...row, justifyContent: "space-between" }}>
        <Label size={12} tone="muted">
          {`#${props.task.number}`}
        </Label>
        <If when={props.task.status === "in_review"}>
          <Label
            size={12}
            tone="amber"
            style={{ backgroundColor: c().amberFill, paddingHorizontal: 4 }}
          >
            {uiText("forYouToCheck")}
          </Label>
        </If>
        <If when={props.task.status === "in_progress"}>
          <Label size={12} tone="blue">
            {`▪ ${(props.task.runStatus ?? "In progress").replaceAll(
              "_",
              " ",
            )}`}
          </Label>
        </If>
      </View>
      <Label line={20}>{props.task.title}</Label>
      <If when={props.task.waitingOn?.[0]}>
        {(dependency) => (
          <Label
            size={12}
            lines={1}
            style={{
              borderWidth: 1,
              borderColor: c().strong,
              paddingHorizontal: 5,
            }}
          >
            {uiText("waitsFor", { title: dependency().title })}
          </Label>
        )}
      </If>
      <If when={props.task.subtasks}>
        {(subtasks) => (
          <View style={{ gap: 3 }}>
            <View style={{ ...row, backgroundColor: c().border, height: 4 }}>
              <View
                style={{
                  backgroundColor: c().green,
                  height: 4,
                  width: `${(subtasks().done / Math.max(1, subtasks().total)) * 100}%`,
                }}
              />
            </View>
            <Label size={12} tone="muted">
              {uiText("subtasksCompleted", {
                done: subtasks().done,
                total: subtasks().total,
              })}
            </Label>
          </View>
        )}
      </If>
      <View style={{ ...row, gap: 4, justifyContent: "space-between" }}>
        <Label size={12} tone="faint" lines={1}>
          {host.agent(
            props.task.assigneeAgentId ?? props.task.createdBy.agentId,
          )?.name ?? ""}
        </Label>
        <Label size={12} tone="faint">
          {relativeTime(props.task.updatedAt)}
        </Label>
      </View>
    </View>
  );
}

const phoneGroups = [
  { name: "Needs you", label: "taskNeedsYou", fold: false },
  { name: "Running", label: "running", fold: false },
  { name: "Waiting for others", label: "taskWaitingForOthers", fold: false },
  { name: "Done", label: "taskDone", fold: true },
  { name: "Backlog", label: "backlog", fold: true },
  { name: "Cancelled", label: "taskCancelled", fold: true },
] as const;

function phoneTaskGroup(task: BoardTaskView) {
  switch (task.status) {
    case "in_review":
    case "blocked":
      return "Needs you";
    case "done":
      return "Done";
    case "backlog":
      return "Backlog";
    case "cancelled":
      return "Cancelled";
    case "in_progress":
      return task.runStatus === "queued" && !task.subtasks?.total
        ? "Waiting for others"
        : "Running";
    case "todo":
      return task.subtasks?.total ? "Running" : "Waiting for others";
  }
}

function PhoneTaskList(props: {
  tasks: BoardTaskView[];
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const expanded = signal<string[]>([]);
  return (
    <Scroll style={grow} scrollbar={false}>
      <Each of={phoneGroups}>
        {(group) => {
          const entries = () =>
            props.tasks.filter((task) => phoneTaskGroup(task) === group().name);
          const open = () => !group().fold || expanded().includes(group().name);
          return (
            <If when={group().fold || entries().length > 0}>
              <View
                role={group().fold ? "button" : undefined}
                accessibilityLabel={`${uiText(group().label)} ${entries().length}`}
                accessibilityState={
                  group().fold ? { expanded: open() } : undefined
                }
                onPress={
                  group().fold
                    ? () =>
                        expanded.update((names) =>
                          open()
                            ? names.filter((name) => name !== group().name)
                            : [...names, group().name],
                        )
                    : undefined
                }
                style={{
                  ...row,
                  height: group().fold ? 32 : 25,
                  paddingHorizontal: 16,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  backgroundColor: group().fold ? c().canvas : c().surface,
                  gap: 6,
                }}
              >
                <Label
                  size={10}
                  weight={600}
                  tone={group().name === "Needs you" ? "amber" : "muted"}
                  style={{ letterSpacing: 0.7, textTransform: "uppercase" }}
                >
                  {`${uiText(group().label)}  ${entries().length}`}
                </Label>
                <If when={group().fold}>
                  <View style={{ flex: 1 }} />
                  <Icon
                    name={open() ? "down" : "right"}
                    size={10}
                    tone="muted"
                  />
                </If>
              </View>
              <If when={open()}>
                <Each of={entries()} key={(entry) => entry.id}>
                  {(entry) => {
                    const owner = () =>
                      host.agent(
                        entry().assigneeAgentId ?? entry().createdBy.agentId,
                      )?.name;
                    const state = () => {
                      const task = entry();
                      if (task.status === "in_review")
                        return uiText("forYouToCheck2");
                      if (task.status === "blocked")
                        return uiText("taskNeedsDecision");
                      if (task.subtasks?.total)
                        return uiText("parentTaskProgress", task.subtasks);
                      const wait = task.waitingOn?.[0];
                      if (wait) {
                        return uiText("waitsForTask", {
                          title: wait.title || `#${wait.number}`,
                        });
                      }
                      if (task.runStatus === "queued") return uiText("queued");
                      if (task.status === "in_progress")
                        return uiText("running");
                      return statusName(task.status);
                    };
                    return (
                      <View
                        role="button"
                        accessibilityLabel={entry().title}
                        onPress={() => props.onOpen(entry().id)}
                        activeStyle={{ backgroundColor: c().selected }}
                        style={{
                          ...row,
                          height: 56,
                          paddingLeft: 30,
                          paddingRight: 16,
                          borderBottomWidth: 1,
                          borderColor: c().border,
                          gap: 12,
                        }}
                      >
                        <View style={{ width: 28, alignItems: "center" }}>
                          <TaskGlyph
                            status={
                              group().name === "Running"
                                ? "in_progress"
                                : entry().status
                            }
                            size={13}
                          />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Label lines={1} line={21}>
                            {entry().title}
                          </Label>
                          <Label
                            size={11}
                            line={16}
                            lines={1}
                            tone={
                              entry().status === "in_review" ? "amber" : "muted"
                            }
                          >
                            {[`#${entry().number}`, owner(), state()]
                              .filter(Boolean)
                              .join(" · ")}
                          </Label>
                        </View>
                        <Label size={10} tone="muted">
                          {relativeTime(entry().updatedAt)}
                        </Label>
                        <Icon name="right" size={9} tone="muted" />
                      </View>
                    );
                  }}
                </Each>
              </If>
            </If>
          );
        }}
      </Each>
    </Scroll>
  );
}

export function Tasks(props: {
  layout: Layout;
  condensed?: boolean;
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
  const view = signal("Board");
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
  const column = (status: BoardTaskStatus) =>
    filtered().filter((task) => task.status === status);
  const groupByParent = () =>
    view() === "List" &&
    !archive() &&
    (props.layout !== "desktop" || listGrouping() === "Part of");
  const byParent = computed(() => {
    const tasks = new Map(host.tasks().map((task) => [task.id, task]));
    const groups = new Map<string, BoardTaskView[]>();
    for (const task of filtered()) {
      const key =
        task.parentId && tasks.has(task.parentId) ? task.parentId : "";
      const entries = groups.get(key) ?? [];
      entries.push(task);
      groups.set(key, entries);
      if (task.subtasks?.total && !groups.has(task.id)) groups.set(task.id, []);
    }
    return {
      groups: [...groups].flatMap(([id, children]) => {
        const parent = tasks.get(id);
        return parent
          ? [{ parent, children: children.sort((a, b) => a.number - b.number) }]
          : [];
      }),
      orphans: (groups.get("") ?? []).filter((task) => !groups.has(task.id)),
    };
  });
  const collapse = (status: string) =>
    expanded.update((items) =>
      items.includes(status)
        ? items.filter((entry) => entry !== status)
        : [...items, status],
    );
  return (
    <View style={{ ...grow, backgroundColor: c().canvas }}>
      <Header
        title={uiText("tasks2")}
        count={shown().length}
        layout={props.layout}
      >
        <If when={!phone()}>
          <Field
            label={uiText("searchTasks")}
            placeholder={uiText("search")}
            value={query()}
            onChange={query.set}
            style={{
              width: 142,
              height: 26,
              borderWidth: 0,
              backgroundColor: c().surface,
              fontSize: 12,
            }}
          />
          <If when={!props.condensed}>
            <Button
              label={host.agent(executor())?.name ?? uiText("executor")}
              end="down"
              tone="ghost"
              onPress={() => filterOpen.set(!filterOpen())}
            />
            <Button
              label={uiText("partOf", {
                value1:
                  parents().find((entry) => entry.id === part())?.title ??
                  uiText("allItems"),
              })}
              end="down"
              tone="ghost"
              onPress={() => partOpen.set(!partOpen())}
            />
            <Button
              label={uiText("archived", {
                length: host.list<BoardTaskView>("tasks", "archived").length,
              })}
              icon="archive"
              tone="ghost"
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
            <View style={row}>
              <Each of={["Board", "List", "Plan"] as const}>
                {(mode) => (
                  <Button
                    label={uiText(taskViews[mode()])}
                    tone={view() === mode() ? "primary" : "plain"}
                    onPress={() => view.set(mode())}
                  />
                )}
              </Each>
            </View>
          </If>
        </If>
        <If when={!phone() && !props.condensed}>
          <Button
            label={uiText("new")}
            tone="primary"
            icon="plus"
            onPress={props.onCreate}
          />
        </If>
      </Header>
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
            title={
              host.state().missing.tasks
                ? uiText("unableToLoadTasks")
                : !host.state().targets.tasks
                  ? uiText("loadingTasks")
                  : shown().length
                    ? uiText("noMatchingTasks")
                    : uiText("noTasksYet")
            }
            icon={host.state().missing.tasks ? "info" : "tasks"}
            description={
              host.state().missing.tasks
                ? uiText("theHostDidNotRespondIn")
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
          else={<PhoneTaskList tasks={filtered()} onOpen={props.onOpen} />}
        >
          <If
            when={view() === "Board" && !archive()}
            else={
              <Scroll style={grow}>
                <View
                  style={{
                    padding: groupByParent() ? 0 : 22,
                    gap: groupByParent() ? 0 : 12,
                  }}
                >
                  <Each
                    of={
                      view() === "Plan" && !phone()
                        ? filtered().filter((task) => !task.parentId)
                        : []
                    }
                    key={(task) => task.id}
                  >
                    {(task) => (
                      <View style={{ gap: 6 }}>
                        <TaskSummary
                          task={task()}
                          onPress={() => props.onOpen(task().id)}
                        />
                        <View style={{ paddingLeft: 20, gap: 6 }}>
                          <Each
                            of={filtered().filter(
                              (subtask) => subtask.parentId === task().id,
                            )}
                            key={(subtask) => subtask.id}
                          >
                            {(subtask) => (
                              <TaskSummary
                                task={subtask()}
                                onPress={() => props.onOpen(subtask().id)}
                              />
                            )}
                          </Each>
                        </View>
                      </View>
                    )}
                  </Each>
                  <If when={groupByParent()}>
                    <Each
                      of={byParent().groups}
                      key={(group) => group.parent.id}
                    >
                      {(group) => {
                        const isFolded = () =>
                          foldedParents().includes(group().parent.id);
                        return (
                          <View>
                            <View
                              style={{
                                ...row,
                                paddingLeft: 8,
                                borderBottomWidth: 1,
                                borderColor: c().border,
                                backgroundColor: c().surface,
                              }}
                            >
                              <Button
                                label={`${isFolded() ? "Expand" : "Collapse"} ${group().parent.title}`}
                                icon={isFolded() ? "right" : "down"}
                                iconOnly
                                tone="ghost"
                                onPress={() =>
                                  foldedParents.update((ids) =>
                                    isFolded()
                                      ? ids.filter(
                                          (id) => id !== group().parent.id,
                                        )
                                      : [...ids, group().parent.id],
                                  )
                                }
                              />
                              <View
                                role="button"
                                accessibilityLabel={group().parent.title}
                                onPress={() => props.onOpen(group().parent.id)}
                                style={{
                                  ...row,
                                  flex: 1,
                                  height: 29,
                                  paddingRight: 14,
                                  gap: 8,
                                  cursor: "pointer",
                                }}
                              >
                                <TaskGlyph
                                  status={group().parent.status}
                                  size={12}
                                />
                                <Label size={12} weight={600} lines={1}>
                                  {group().parent.title}
                                </Label>
                                <Label
                                  size={10}
                                  tone="muted"
                                  lines={1}
                                  style={{ flex: 1 }}
                                >
                                  {uiText("subtasksDone", {
                                    number: group().parent.number,
                                    value2: group().parent.subtasks?.total ?? 0,
                                    value3: group().parent.subtasks?.done ?? 0,
                                    value4: group().parent.subtasks?.total ?? 0,
                                  })}
                                </Label>
                                <View
                                  style={{
                                    ...row,
                                    gap: 2,
                                    width: props.layout === "desktop" ? 80 : 90,
                                  }}
                                >
                                  <Each
                                    of={host
                                      .tasks()
                                      .filter(
                                        (child) =>
                                          child.parentId === group().parent.id,
                                      )
                                      .sort((a, b) => a.number - b.number)}
                                    key={(child) => child.id}
                                  >
                                    {(child) => (
                                      <View
                                        style={{
                                          height:
                                            props.layout === "desktop" ? 4 : 3,
                                          flex: 1,
                                          backgroundColor:
                                            c()[tones[child().status]],
                                        }}
                                      />
                                    )}
                                  </Each>
                                </View>
                              </View>
                            </View>
                            <If when={!isFolded()}>
                              <View>
                                <Each
                                  of={group().children}
                                  key={(task) => task.id}
                                >
                                  {(task) => (
                                    <TaskTableRow
                                      layout={props.layout}
                                      nested
                                      item={task()}
                                      onOpen={() => props.onOpen(task().id)}
                                    />
                                  )}
                                </Each>
                              </View>
                            </If>
                          </View>
                        );
                      }}
                    </Each>
                    <If when={byParent().orphans.length}>
                      <View>
                        <Label size={12} tone="muted" style={{ padding: 8 }}>
                          {uiText("notPartOfAnything", {
                            length: byParent().orphans.length,
                          })}
                        </Label>
                        <Each of={byParent().orphans} key={(task) => task.id}>
                          {(task) => (
                            <TaskTableRow
                              layout={props.layout}
                              item={task()}
                              onOpen={() => props.onOpen(task().id)}
                            />
                          )}
                        </Each>
                      </View>
                    </If>
                  </If>
                  <If when={(view() !== "Plan" || phone()) && !groupByParent()}>
                    <Each of={visibleStatuses}>
                      {(status) => (
                        <View style={{ gap: 5 }}>
                          <Button
                            label={`${statusName(status())} ${
                              column(status()).length
                            }`}
                            tone="ghost"
                            end={
                              expanded().includes(status()) ? "right" : "down"
                            }
                            onPress={() => collapse(status())}
                          />
                          <If when={!expanded().includes(status())}>
                            <Each of={column(status())} key={(task) => task.id}>
                              {(task) => (
                                <TaskTableRow
                                  layout={props.layout}
                                  item={task()}
                                  onOpen={() => props.onOpen(task().id)}
                                />
                              )}
                            </Each>
                          </If>
                        </View>
                      )}
                    </Each>
                  </If>
                </View>
              </Scroll>
            }
          >
            <View
              style={{
                ...row,
                ...grow,
                paddingHorizontal: 22,
                paddingTop: 12,
                gap: 8,
                alignItems: "stretch",
              }}
            >
              <Each of={visibleStatuses}>
                {(status) => {
                  const folded = () =>
                    !mainStatuses.includes(status()) &&
                    !expanded().includes(status());
                  return (
                    <View
                      ref={(view) => boardDrag.register(status(), view)}
                      style={{
                        flex: folded() ? undefined : 1,
                        width: folded() ? 34 : undefined,
                        minWidth: 0,
                        backgroundColor: folded() ? c().surface : c().canvas,
                      }}
                    >
                      <View
                        role="button"
                        accessibilityLabel={statusName(status())}
                        onPress={() => collapse(status())}
                        style={{
                          ...row,
                          gap: 7,
                          minHeight: 32,
                          justifyContent: folded() ? "center" : "flex-start",
                        }}
                      >
                        <TaskGlyph status={status()} size={12.6} />
                        <If when={!folded()}>
                          <Label size={12}>{statusName(status())}</Label>
                          <Label size={12} tone="muted">
                            {column(status()).length}
                          </Label>
                        </If>
                      </View>
                      <If
                        when={folded()}
                        else={
                          <Scroll style={grow} scrollbar={false}>
                            <View style={{ gap: 7 }}>
                              <Each
                                of={column(status())}
                                key={(task) => task.id}
                              >
                                {(task) => (
                                  <BoardCard
                                    task={task()}
                                    drag={boardDrag}
                                    draggable={
                                      props.layout === "desktop" &&
                                      !task().subtasks
                                    }
                                    onOpen={() => props.onOpen(task().id)}
                                  />
                                )}
                              </Each>
                            </View>
                          </Scroll>
                        }
                      >
                        <View
                          style={{
                            width: 34,
                            height: 85,
                            alignItems: "center",
                            justifyContent: "flex-start",
                          }}
                        >
                          <Label
                            size={12}
                            line={16}
                            tone="muted"
                            style={{
                              width: 85,
                              textAlign: "left",
                              position: "absolute",
                              top: 34,
                              left: -26,
                              transform: "rotate(90deg)",
                            }}
                          >
                            {`${statusName(status())}  ${column(status()).length}`}
                          </Label>
                        </View>
                      </If>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>
        </If>
      </If>
    </View>
  );
}

function TaskTableRow(props: {
  item: BoardTaskView;
  layout: Layout;
  nested?: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  const host = useHost();
  const desktop = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  const hint = () => {
    const task = props.item;
    const wait = task.waitingOn?.[0];
    if (wait)
      return uiText(
        wait.state === "cancelled" ? "prerequisiteCancelled" : "waitsForTask",
        { title: wait.title },
      );
    if (task.status === "in_review") return uiText("forYouToCheck2");
    if (task.runStatus) return task.runStatus.replaceAll("_", " ");
    return statusName(task.status);
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.item.title}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 32,
        borderBottomWidth: 1,
        borderColor: c().border,
        paddingLeft: props.nested ? (desktop() ? 38 : 34) : 14,
        paddingRight: 14,
        gap: desktop() ? 0 : 8,
        cursor: "pointer",
      }}
    >
      <View style={{ width: desktop() ? 24 : 14 }}>
        <TaskGlyph status={props.item.status} size={14} />
      </View>
      <Label
        size={10}
        line={12}
        tone="muted"
        style={{ width: desktop() ? 36 : 30 }}
      >{`#${props.item.number}`}</Label>
      <Label size={12} line={16} lines={1} style={{ flex: 1 }}>
        {props.item.title}
      </Label>
      <Label
        size={desktop() ? 10 : 11}
        line={14}
        lines={1}
        tone={
          props.item.waitingOn?.length ? "mutedInk" : tones[props.item.status]
        }
        style={{ width: phone() ? 72 : desktop() ? 183 : 160 }}
      >
        {hint()}
      </Label>
      <If when={!phone()}>
        <Label
          size={desktop() ? 10 : 11}
          line={14}
          tone="mutedInk"
          lines={1}
          style={{ width: desktop() ? 100 : 50 }}
        >
          {host.agent(
            props.item.assigneeAgentId ?? props.item.createdBy.agentId,
          )?.name ?? uiText("unassigned")}
        </Label>
        <Label
          size={desktop() ? 10 : 11}
          line={14}
          tone="muted"
          lines={1}
          style={{ width: desktop() ? 116 : 80, textAlign: "right" }}
        >
          {relativeTime(props.item.updatedAt)}
        </Label>
      </If>
    </View>
  );
}

export function TaskDetail(props: {
  id: string;
  layout: Layout;
  docked?: boolean;
  onClose: () => void;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const target = () => `tasks.${props.id}`;
  follow(target);
  const task = () => host.section<BoardTaskDetail>(target(), "task");
  const activity = () => host.list<TaskActivityView>(target(), "activity");
  const comment = signal("");
  const posting = signal(false);
  const archive = signal(false);
  const editing = signal(false);
  const panel = signal(false);
  const plan = signal(false);
  const editTitle = signal("");
  const editDescription = signal("");
  const log = signal<TaskRunView | undefined>(undefined);
  const status = signal(false);
  const review = signal<"done" | "todo" | undefined>(undefined);
  const feedback = signal("");
  const submitting = signal(false);
  const replacing = signal(false);
  const cancelling = signal(false);
  const search = signal("");
  const executor = () =>
    host.agent(task()?.assigneeAgentId ?? task()?.createdBy.agentId);
  const activeArchiveTargets = () => {
    const current = task();
    if (!current) return [];
    const byId = new Map(host.tasks().map((item) => [item.id, item]));
    return [...byId.values()].filter((item) => {
      if (!item.runStatus || !isActiveRunStatus(item.runStatus)) return false;
      let next: BoardTaskView | undefined = item;
      while (next) {
        if (next.id === current.id) return true;
        next = next.parentId ? byId.get(next.parentId) : undefined;
      }
      return false;
    });
  };
  const canComment = (item: BoardTaskDetail) =>
    !item.archivedAt &&
    !item.children?.length &&
    !item.waitingOn?.length &&
    ["todo", "in_progress", "blocked"].includes(item.status);
  const cancelledEdges = () =>
    (task()?.waitingOn ?? []).filter(
      (edge) => edge.state === "cancelled" && edge.via === null,
    );
  let feedbackId: string | undefined;
  const phone = () => props.layout === "phone";
  const side = () => props.layout === "desktop" && !props.docked;
  let commentId: string | undefined;
  async function post() {
    if (!comment().trim() || posting()) return;
    posting.set(true);
    commentId ??= crypto.randomUUID();
    const result = await host.action(() =>
      host.call("tasks", "comment", {
        taskId: props.id,
        body: comment().trim(),
        clientId: commentId,
      }),
    );
    posting.set(false);
    if (result) {
      comment.set("");
      commentId = undefined;
    }
  }
  async function mutate(work: () => Promise<void>) {
    if (submitting()) return;
    submitting.set(true);
    await host.action(work);
    submitting.set(false);
  }
  function change(next: BoardTaskStatus) {
    void mutate(async () => {
      await host.call("tasks", "update", { taskId: props.id, status: next });
      status.set(false);
      cancelling.set(false);
      review.set(undefined);
    });
  }
  function submitReview(next: "done" | "todo") {
    if (next === "done") {
      change("done");
      return;
    }
    const body = feedback().trim();
    if (!body) return;
    void mutate(async () => {
      feedbackId ??= crypto.randomUUID();
      await host.call("tasks", "comment", {
        taskId: props.id,
        body,
        clientId: feedbackId,
      });
      feedbackId = undefined;
      feedback.set("");
      review.set(undefined);
    });
  }
  function resolveBlock(replacement?: string) {
    void mutate(async () => {
      const edges = cancelledEdges();
      if (replacement)
        await host.call("tasks", "addDependency", {
          taskId: props.id,
          dependsOn: replacement,
        });
      for (const edge of edges)
        await host.call("tasks", "removeDependency", {
          taskId: props.id,
          dependsOn: edge.taskId,
        });
      replacing.set(false);
    });
  }
  function TaskLink(link: {
    item: {
      taskId: string;
      number: number;
      title: string;
      status: BoardTaskStatus;
    };
    suffix?: string;
  }) {
    return (
      <View
        role="button"
        onPress={() => props.onTask(link.item.taskId)}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          minHeight: 43,
          paddingVertical: 5,
          gap: 8,
          borderBottomWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <TaskGlyph status={link.item.status} size={12} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Label size={13}>{`#${link.item.number} ${link.item.title}`}</Label>
          <If when={link.suffix}>
            <Label size={11} tone="muted">
              {link.suffix}
            </Label>
          </If>
        </View>
        <Icon name="right" size={10} tone="muted" />
      </View>
    );
  }
  function openRelated(id: string) {
    props.onTask(id);
  }
  function Prerequisites(props: { item: BoardTaskDetail }) {
    const waiting = () => props.item.waitingOn ?? [];
    const cancelled = () =>
      waiting().some((edge) => edge.state === "cancelled");
    return (
      <If
        when={
          waiting().length &&
          (props.item.status === "todo" || props.item.status === "blocked")
        }
      >
        <View
          style={{
            padding: cancelled() ? 16 : 12,
            gap: 7,
            borderWidth: 1,
            borderColor: c().border,
            borderLeftWidth: cancelled() ? 2 : 1,
            borderLeftColor: cancelled() ? c().red : c().strong,
          }}
        >
          <View style={{ ...row, gap: 7 }}>
            <If when={!cancelled()}>
              <Icon name="lock" size={15} tone="muted" />
            </If>
            <Label size={13} weight={600}>
              {cancelled()
                ? uiText("thisTaskIsStuckAndNeeds")
                : uiText("waitingForPrerequisites")}
            </Label>
          </View>
          <Label size={12} line={18}>
            {cancelled()
              ? uiText("wasCancelledThisTaskStaysBlocked", {
                  join: waiting()
                    .filter((edge) => edge.state === "cancelled")
                    .map((edge) => `“${edge.title}” (#${edge.number})`)
                    .join(", "),
                })
              : uiText("waitingForThisTaskStartsWhen", {
                  join: waiting()
                    .map((edge) => `“${edge.title}”`)
                    .join(", "),
                })}
          </Label>
          <If when={cancelledEdges().length && !props.item.archivedAt}>
            <View style={{ gap: 6, paddingVertical: 3 }}>
              <Button
                label={uiText("dontWaitStartNow")}
                size={40}
                tone="primary"
                disabled={submitting()}
                onPress={() => resolveBlock()}
              />
              <Button
                label={uiText("waitForAnotherTask")}
                size={40}
                disabled={submitting()}
                onPress={() => {
                  search.set("");
                  replacing.set(true);
                }}
              />
              <Button
                label={uiText("cancelThisTask")}
                size={40}
                disabled={submitting()}
                onPress={() => cancelling.set(true)}
              />
            </View>
          </If>
          <Each
            of={waiting().filter(
              (edge) => edge.state === "cancelled" || edge.via !== null,
            )}
            key={(edge) => edge.taskId}
          >
            {(edge) => {
              const ancestor = () =>
                props.item.ancestors?.find(
                  (item) => item.number === edge().via,
                );
              return (
                <View
                  role="button"
                  onPress={() =>
                    openRelated(ancestor()?.taskId ?? edge().taskId)
                  }
                  style={{
                    minHeight: 21,
                    cursor: "pointer",
                    justifyContent: "center",
                  }}
                >
                  <Label size={12} tone="blue">
                    {ancestor()
                      ? uiText("openParentTask", { via: edge().via })
                      : uiText("seeWhyWasCancelled", { number: edge().number })}
                  </Label>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    );
  }
  function Subtasks(props: { item: BoardTaskDetail }) {
    const children = () => props.item.children ?? [];
    const highlights = () =>
      [
        ["Now", children().find((item) => item.status === "in_progress")],
        ["Next", children().find((item) => item.status === "todo")],
        ["To review", children().find((item) => item.status === "in_review")],
      ] as const;
    return (
      <View style={{ gap: 7, marginTop: 4 }}>
        <Caption text={uiText("progress")} />
        <View style={{ ...row, gap: 3 }}>
          <Each
            of={children().filter((child) => child.status !== "cancelled")}
            key={(child) => child.taskId}
          >
            {(child) => (
              <View
                style={{
                  height: 4,
                  flex: 1,
                  backgroundColor: [
                    "done",
                    "in_progress",
                    "in_review",
                    "blocked",
                  ].includes(child().status)
                    ? c()[tones[child().status]]
                    : c().border,
                }}
              />
            )}
          </Each>
        </View>
        <If when={props.item.subtasks}>
          {(count) => (
            <Label size={12} tone="muted">
              {uiText("ofDoneTheParentDoesNo", {
                done: count().done,
                total: count().total,
              })}
            </Label>
          )}
        </If>
        <Each
          of={highlights().filter(([, item]) => !!item)}
          key={(entry) => entry[0]}
        >
          {(entry) => (
            <View style={{ ...row, gap: 8 }}>
              <Label size={12} tone="muted" style={{ width: 66 }}>
                {entry()[0]}
              </Label>
              <Label
                size={12}
                tone={entry()[0] === "To review" ? "amber" : "ink"}
              >
                {entry()[1]?.title}
              </Label>
            </View>
          )}
        </Each>
        <Caption text={uiText("subtasks")} />
        <Each of={children()} key={(child) => child.taskId}>
          {(child) => (
            <TaskLink item={child()} suffix={statusName(child().status)} />
          )}
        </Each>
      </View>
    );
  }
  function stop(run: TaskRunView) {
    void mutate(async () => {
      await host.call("tasks", "interrupt", {
        taskId: props.id,
        runId: run.id,
      });
    });
  }
  function RunSummary(props: { item: BoardTaskDetail }) {
    const run = () => props.item.runs.at(-1);
    const review = () => props.item.status === "in_review";
    return (
      <If
        when={
          review() || props.item.status === "in_progress" ? run() : undefined
        }
      >
        {(entry) => (
          <View
            style={{
              ...row,
              minHeight: 56,
              paddingHorizontal: 10,
              gap: 8,
              borderWidth: 1,
              borderColor: review() ? c().amber : c().border,
            }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                backgroundColor: c()[review() ? "amber" : "blue"],
              }}
            />
            <View
              role="button"
              accessibilityLabel={uiText("executionLog")}
              style={{
                ...row,
                flex: 1,
                minWidth: 0,
                gap: 8,
                cursor: "pointer",
              }}
              onPress={() => log.set(entry())}
            >
              <View style={{ flex: 1, gap: 1 }}>
                <Label size={13} weight={600}>
                  {(executor()?.name ?? "The executor") +
                    (review() ? " delivered this turn" : " is working")}
                </Label>
                <Label size={11} tone="muted">
                  {uiText("executionLogWithCount", {
                    runCaption: runCaption(entry(), props.item.runs.length - 1),
                  })}
                </Label>
              </View>
              <Icon name="right" size={10} tone="muted" />
            </View>
            <If when={activeTaskRun(entry())}>
              <Button
                label={uiText("stop")}
                size={26}
                disabled={submitting()}
                onPress={() => stop(entry())}
              />
            </If>
          </View>
        )}
      </If>
    );
  }
  function CommentBox() {
    return (
      <View
        style={{
          ...row,
          gap: 6,
          borderWidth: 1,
          borderColor: c().strong,
          paddingRight: 6,
        }}
      >
        <Field
          label={uiText("comment")}
          placeholder={uiText("replyARunningTaskReadsIt")}
          value={comment()}
          onChange={(value) => {
            if (!posting() && value !== comment()) {
              commentId = undefined;
              comment.set(value);
            }
          }}
          onSubmit={() => void post()}
          style={{ flex: 1, borderWidth: 0 }}
        />
        <Button
          label={phone() ? uiText("send") : uiText("sendComment")}
          icon="arrowUp"
          iconOnly={!phone()}
          tone={phone() ? "primary" : "ghost"}
          size={28}
          disabled={posting() || !comment().trim()}
          onPress={() => void post()}
        />
      </View>
    );
  }
  function ReviewActions() {
    return (
      <View
        style={{
          ...row,
          gap: 8,
          paddingHorizontal: phone() ? 16 : 0,
          paddingVertical: phone() ? 9 : 0,
        }}
      >
        <Button
          label={uiText("sendBack")}
          disabled={!executor() || submitting()}
          size={phone() ? 40 : 26}
          style={{ flex: phone() ? 1 : undefined }}
          onPress={() => review.set("todo")}
        />
        <Button
          label={uiText("acceptAsDone")}
          size={phone() ? 40 : 26}
          tone="primary"
          style={{ flex: phone() ? 1 : undefined }}
          onPress={() => review.set("done")}
        />
      </View>
    );
  }
  function Details(detail: { item: BoardTaskDetail }) {
    const item = () => detail.item;
    const executor = () =>
      host.agent(item().assigneeAgentId ?? item().createdBy.agentId);
    const fields = () =>
      [
        ["Executor", executor()?.name ?? "Unassigned"],
        [
          "Belongs to",
          item().ancestors?.at(-1)
            ? `#${item().ancestors!.at(-1)!.number} ${
                item().ancestors!.at(-1)!.title
              }`
            : "",
        ],
        [
          "Workspace",
          item().workspace.mode === "worktree"
            ? "Own git worktree"
            : (item().workspace.path ?? "Project directory"),
        ],
        ["Run", item().runs.at(-1)?.status ?? ""],
        ["Updated", relativeTime(item().updatedAt)],
      ].filter(([, value]) => value);
    return (
      <View style={{ gap: 10 }}>
        <View style={{ ...row, gap: 8, alignItems: "flex-start" }}>
          <Label size={11} tone="muted" style={{ width: 68 }}>
            {uiText("status")}
          </Label>
          <View style={{ gap: 4, flex: 1 }}>
            <View
              role="button"
              accessibilityLabel={uiText("changeStatus")}
              onPress={() => status.set(!status())}
              style={{ ...row, gap: 6, cursor: "pointer" }}
            >
              <TaskStatus task={item()} />
              <Icon name="down" size={9} tone="muted" />
            </View>
            <If when={status()}>
              <View style={{ gap: 4 }}>
                <Each of={TASK_STATUSES}>
                  {(entry) => (
                    <Button
                      label={statusName(entry())}
                      selected={entry() === item().status}
                      onPress={() => change(entry())}
                    />
                  )}
                </Each>
              </View>
            </If>
          </View>
        </View>
        <Each of={fields()} key={(field) => field[0]}>
          {(field) => (
            <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
              <Label size={11} tone="muted" style={{ width: 68 }}>
                {field()[0]}
              </Label>
              <Label size={12} style={{ flex: 1 }} weight={500}>
                {field()[1]}
              </Label>
            </View>
          )}
        </Each>
        <If
          when={
            item().status === "in_review" &&
            !item().children?.length &&
            !phone()
          }
        >
          <ReviewActions />
        </If>
      </View>
    );
  }
  return (
    <View
      style={{ ...grow, position: "relative", backgroundColor: c().canvas }}
    >
      <Header
        title={
          phone() || props.docked
            ? task()
              ? uiText("task", { number: task()?.number })
              : "Task"
            : (task()?.title ?? "Task")
        }
        layout={props.layout}
        onBack={props.onClose}
        inset={props.docked ? 8 : undefined}
      >
        <View style={{ flex: 1 }} />
        <If when={task()}>
          <If when={!phone() && task()?.children?.length}>
            <View style={row}>
              <Button
                label={uiText("overview")}
                tone={plan() ? "ghost" : "primary"}
                onPress={() => plan.set(false)}
              />
              <Button
                label={uiText("plan")}
                tone={plan() ? "primary" : "ghost"}
                onPress={() => plan.set(true)}
              />
            </View>
          </If>
          <If when={props.layout === "tablet" && !props.docked}>
            <Button
              label={uiText("panel")}
              icon="sidebar"
              tone="ghost"
              onPress={() => panel.set(true)}
            />
          </If>
          <ActionMenu label={uiText("taskActions")}>
            <ActionItem
              label={uiText("edit")}
              onSelect={() => {
                editTitle.set(task()?.title ?? "");
                editDescription.set(task()?.description ?? "");
                editing.set(true);
              }}
            />
            <If when={phone() && !task()?.children?.length}>
              <ActionItem
                label={uiText("changeStatus")}
                onSelect={() => status.set(true)}
              />
            </If>
            <If when={!task()?.children?.length && task()?.runs.length}>
              <ActionItem
                label={uiText("rerun")}
                onSelect={() =>
                  void host.action(() =>
                    host.call("tasks", "rerun", { taskId: props.id }),
                  )
                }
              />
            </If>
            <ActionItem
              label={
                task()?.archivedAt ? uiText("unarchive") : uiText("archive")
              }
              onSelect={() => {
                if (task()?.archivedAt)
                  void host.action(() =>
                    host.call("tasks", "unarchive", { taskId: props.id }),
                  );
                else archive.set(true);
              }}
            />
          </ActionMenu>
        </If>
      </Header>
      <If when={task()} else={<Empty title={uiText("loadingTask")} />}>
        {(item) => (
          <>
            <If
              when={!phone() && plan() && item().children?.length}
              else={
                <View style={{ ...row, ...grow, alignItems: "stretch" }}>
                  <Scroll style={grow} scrollbar={false}>
                    <View
                      style={{
                        paddingHorizontal: phone() ? 16 : 20,
                        paddingTop: 12,
                        paddingBottom: 20,
                        width: "100%",
                        maxWidth: 728,
                        alignSelf: "center",
                        gap: 12,
                      }}
                    >
                      <Label size={11} tone="muted">
                        {uiText("createdBy", {
                          number: item().number,
                          value2: item().subtasks?.total ? " · Parent" : "",
                          value3:
                            host.agent(item().createdBy.agentId)?.name ?? "you",
                          relativeTime: relativeTime(item().createdAt),
                          value5: item().ancestors?.at(-1)
                            ? ` · Part of #${item().ancestors!.at(-1)!.number}`
                            : "",
                        })}
                      </Label>
                      <View style={{ ...row, gap: 10 }}>
                        <TaskGlyph status={item().status} size={16} />
                        <Label
                          size={phone() ? 18 : 20}
                          line={phone() ? 24 : 26}
                          weight={600}
                          style={{ flex: 1 }}
                        >
                          {item().title}
                        </Label>
                        <If
                          when={
                            props.layout === "tablet" &&
                            !props.docked &&
                            !item().children?.length
                          }
                        >
                          <ActionMenu
                            label={uiText("changeStatus")}
                            value={statusName(item().status)}
                          >
                            <Each of={TASK_STATUSES}>
                              {(entry) => (
                                <ActionItem
                                  label={statusName(entry())}
                                  checked={item().status === entry()}
                                  onSelect={() => change(entry())}
                                />
                              )}
                            </Each>
                          </ActionMenu>
                        </If>
                      </View>
                      <If when={phone()}>
                        <View
                          style={{
                            ...row,
                            flexWrap: "wrap",
                            gap: 5,
                            marginTop: -7,
                          }}
                        >
                          <Label size={12} tone={tones[item().status]}>
                            {item().status === "in_review" &&
                            !item().children?.length
                              ? uiText("forYouToCheck2")
                              : statusName(item().status)}
                          </Label>
                          <If when={executor()}>
                            {(agent) => (
                              <Label size={12} tone="muted">
                                {uiText("executorWithCount", {
                                  name: agent().name,
                                })}
                              </Label>
                            )}
                          </If>
                          <Label size={12} tone="muted">
                            {item().workspace.mode === "worktree"
                              ? uiText("ownGitWorktree")
                              : uiText("projectDirectory")}
                          </Label>
                        </View>
                        <RunSummary item={item()} />
                      </If>
                      <Prerequisites item={item()} />
                      <If when={item().children?.length}>
                        <Subtasks item={item()} />
                      </If>
                      <If when={item().description}>
                        <Label weight={600} size={15}>
                          {item().children?.length
                            ? uiText("description")
                            : uiText("goal")}
                        </Label>
                        <Markdown
                          value={item().description}
                          line={22}
                          compactHeadings={phone()}
                        />
                      </If>
                      <If
                        when={
                          item().waitingOn?.length ||
                          item().dependsOn?.length ||
                          item().dependents?.length
                        }
                      >
                        <Caption text={uiText("dependencies")} />
                        <Each
                          of={item().dependsOn ?? []}
                          key={(entry) => entry.taskId}
                        >
                          {(entry) => (
                            <TaskLink
                              item={entry()}
                              suffix={`Waits for it · ${entry().state === "resolved" ? "ready" : entry().state === "cancelled" ? "cancelled" : statusName(entry().status)}`}
                            />
                          )}
                        </Each>
                        <Each
                          of={item().dependents ?? []}
                          key={(entry) => entry.taskId}
                        >
                          {(entry) => (
                            <TaskLink
                              item={entry()}
                              suffix="Waits for this task"
                            />
                          )}
                        </Each>
                      </If>
                      <If
                        when={
                          item().runs.length &&
                          (!phone() || item().status !== "blocked")
                        }
                      >
                        <Caption
                          text={uiText("runs", { length: item().runs.length })}
                        />
                        <Each of={item().runs} key={(run) => run.id}>
                          {(run) => (
                            <View
                              style={{
                                ...row,
                                gap: 7,
                                padding: 8,
                                borderWidth: 1,
                                borderColor: c().border,
                              }}
                            >
                              <Label size={12} style={{ flex: 1 }}>
                                {phone()
                                  ? runCaption(
                                      run(),
                                      item().runs.findIndex(
                                        (entry) => entry.id === run().id,
                                      ),
                                    )
                                  : run().status}
                              </Label>
                              <Button
                                label={uiText("runLog")}
                                end="right"
                                onPress={() => log.set(run())}
                              />
                              <If
                                when={
                                  activeTaskRun(run()) &&
                                  (!phone() ||
                                    run().id !== item().runs.at(-1)?.id)
                                }
                              >
                                <Button
                                  label={uiText("stop")}
                                  disabled={submitting()}
                                  onPress={() => stop(run())}
                                />
                              </If>
                            </View>
                          )}
                        </Each>
                      </If>
                      <View style={{ gap: 5, marginTop: 3 }}>
                        <Caption text={uiText("activity")} />
                        <Each
                          of={
                            phone()
                              ? activity()
                                  .slice()
                                  .reverse()
                                  .filter(
                                    (entry) => entry.kind !== "run_queued",
                                  )
                              : activity()
                          }
                          key={(entry) => entry.id}
                        >
                          {(entry) => (
                            <View style={{ gap: 2 }}>
                              <Label size={11} tone="muted">
                                {`${
                                  host.agent(entry().actor.agentId)?.name ??
                                  (entry().actor.kind === "user"
                                    ? "You"
                                    : "Eta")
                                } · ${taskActivityLabel(entry())} · ${relativeTime(entry().createdAt)}`}
                              </Label>
                              <If when={entry().body}>
                                <Markdown
                                  value={entry().body ?? ""}
                                  line={22}
                                />
                              </If>
                            </View>
                          )}
                        </Each>
                      </View>
                      <If when={!phone() && canComment(item())}>
                        <CommentBox />
                      </If>
                      <If when={!phone() && !side() && props.docked}>
                        <Details item={item()} />
                      </If>
                    </View>
                  </Scroll>
                  <If when={side()}>
                    <View
                      style={{
                        width: 280,
                        padding: 16,
                        borderLeftWidth: 1,
                        borderColor: c().border,
                        flexShrink: 0,
                      }}
                    >
                      <Details item={item()} />
                    </View>
                  </If>
                </View>
              }
            >
              <TaskPlan
                task={item}
                onOpen={props.onTask}
                desktop={props.layout === "desktop"}
              />
            </If>
            <If
              when={
                props.layout === "tablet" &&
                !props.docked &&
                !plan() &&
                item().status === "in_review" &&
                !item().children?.length &&
                !item().archivedAt
              }
            >
              <View
                style={{
                  ...row,
                  justifyContent: "space-between",
                  padding: 14,
                  gap: 12,
                  borderTopWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Label size={12} tone="muted" style={{ flex: 1 }}>
                  {uiText("forYouToCheck2")}
                </Label>
                <ReviewActions />
              </View>
            </If>
            <If
              when={phone() && !item().archivedAt && !item().children?.length}
            >
              <If when={item().status === "in_review"}>
                <View
                  style={{
                    borderTopWidth: 1,
                    borderColor: c().border,
                    paddingTop: 9,
                  }}
                >
                  <Label
                    size={11}
                    tone="muted"
                    style={{ paddingHorizontal: 16 }}
                  >
                    {uiText("acceptTheResultOrSendIt")}
                  </Label>
                  <ReviewActions />
                </View>
              </If>
              <If when={canComment(item())}>
                <View
                  style={{
                    padding: 12,
                    borderTopWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <CommentBox />
                </View>
              </If>
            </If>
          </>
        )}
      </If>
      <If when={phone() && status()}>
        <Modal
          title={uiText("changeStatus")}
          phone
          sheet
          onClose={() => status.set(false)}
        >
          <View style={{ padding: 16, gap: 6 }}>
            <Each of={TASK_STATUSES}>
              {(entry) => (
                <Button
                  label={statusName(entry())}
                  selected={entry() === task()?.status}
                  disabled={submitting()}
                  onPress={() => change(entry())}
                />
              )}
            </Each>
          </View>
        </Modal>
      </If>
      <If when={replacing()}>
        <Modal
          title={uiText("waitForAnotherTask2")}
          phone={phone()}
          sheet={phone()}
          height={phone() ? "66%" : 440}
          onClose={() => replacing.set(false)}
        >
          <View style={{ ...grow, padding: 16, gap: 8 }}>
            <Field
              label={uiText("findATask")}
              placeholder={uiText("findATask")}
              value={search()}
              onChange={search.set}
            />
            <Scroll style={grow}>
              <Each
                of={host
                  .tasks()
                  .filter(
                    (item) =>
                      item.id !== props.id &&
                      item.status !== "cancelled" &&
                      !item.archivedAt &&
                      !task()?.dependsOn?.some(
                        (edge) => edge.taskId === item.id,
                      ) &&
                      (item.title
                        .toLowerCase()
                        .includes(search().trim().toLowerCase()) ||
                        `#${item.number}`.includes(search().trim())),
                  )}
                key={(item) => item.id}
              >
                {(item) => (
                  <Button
                    label={`#${item().number} ${item().title}`}
                    size={38}
                    end="right"
                    tone="ghost"
                    disabled={submitting()}
                    onPress={() => resolveBlock(item().id)}
                  />
                )}
              </Each>
            </Scroll>
          </View>
        </Modal>
      </If>
      <If when={cancelling()}>
        <Modal
          title={uiText("cancelThisTask2")}
          phone={phone()}
          sheet={phone()}
          onClose={() => cancelling.set(false)}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Label>{uiText("thisWillCancelTheTaskAnd")}</Label>
            <Button
              label={uiText("cancelTask")}
              tone="danger"
              disabled={submitting()}
              onPress={() => change("cancelled")}
            />
          </View>
        </Modal>
      </If>
      <If when={review()}>
        {(next) => (
          <Modal
            title={
              next() === "done"
                ? uiText("acceptAsDone")
                : uiText("sendBackTo", {
                    value1: executor()?.name ?? "the executor",
                  })
            }
            phone={phone()}
            sheet={phone()}
            overPhoneNavigation={phone()}
            modalFocus
            dismissible={!submitting()}
            onClose={() => review.set(undefined)}
          >
            <View style={{ padding: 16, gap: 14 }}>
              <If when={next() === "todo"}>
                <Field
                  label={uiText("feedback")}
                  placeholder={uiText("whatNeedsToChange")}
                  multiline
                  value={feedback()}
                  onChange={(value) => {
                    if (!submitting() && value !== feedback()) {
                      feedbackId = undefined;
                      feedback.set(value);
                    }
                  }}
                  style={{ height: 92 }}
                />
              </If>
              <If when={next() === "done"}>
                <View style={{ ...row, gap: 8 }}>
                  <TaskGlyph status="in_review" />
                  <Label size={13} tone="muted">
                    {uiText("inReview")}
                  </Label>
                  <Label size={13}>→</Label>
                  <TaskGlyph status="done" />
                  <Label size={13} weight={600}>
                    {uiText("completed")}
                  </Label>
                </View>
              </If>
              <Label size={13} line={20}>
                {next() === "done"
                  ? [
                      uiText("acceptTaskDescription", {
                        title: task()?.title ?? "",
                        number: task()?.number ?? "",
                      }),
                      task()?.workspaceMode === "worktree"
                        ? uiText("taskBranchRetained")
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : uiText("theExecutorWillGetYourFeedback")}
              </Label>
              <If when={next() === "done" && task()?.dependents?.length}>
                <View
                  style={{ padding: 12, gap: 6, backgroundColor: c().selected }}
                >
                  <Label size={11} tone="muted">
                    {uiText(
                      task()?.dependents?.length === 1
                        ? "oneTaskWaitsForIt"
                        : "taskDependentCount",
                      {
                        count: task()?.dependents?.length ?? 0,
                      },
                    )}
                  </Label>
                  <Scroll style={{ maxHeight: 120 }}>
                    <Each
                      of={task()?.dependents ?? []}
                      key={(edge) => edge.taskId}
                    >
                      {(edge) => (
                        <View style={{ ...row, gap: 7, minHeight: 18 }}>
                          <TaskGlyph status={edge().status} size={14} />
                          <Label
                            size={13}
                          >{`#${edge().number} ${edge().title}`}</Label>
                        </View>
                      )}
                    </Each>
                  </Scroll>
                </View>
              </If>
            </View>
            <View
              style={{
                ...row,
                paddingHorizontal: 16,
                height: 56,
                gap: 8,
                justifyContent: "flex-end",
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <Button
                label={uiText("cancel")}
                disabled={submitting()}
                size={32}
                tone="ghost"
                onPress={() => review.set(undefined)}
              />
              <Button
                label={
                  next() === "done"
                    ? uiText("acceptAsDone")
                    : uiText("sendBack")
                }
                size={32}
                tone="primary"
                disabled={
                  submitting() || (next() === "todo" && !feedback().trim())
                }
                onPress={() => submitReview(next())}
              />
            </View>
          </Modal>
        )}
      </If>
      <If when={panel() && task()}>
        <Modal
          title={uiText("taskDetails")}
          side
          width={360}
          height="100%"
          blurBackdrop={false}
          overPhoneNavigation
          onClose={() => panel.set(false)}
        >
          <View style={{ padding: 16 }}>
            <Details item={task()!} />
          </View>
        </Modal>
      </If>
      <If when={editing()}>
        <Modal
          title={uiText("editTask")}
          phone={phone()}
          sheet={phone()}
          onClose={() => editing.set(false)}
        >
          <View style={{ padding: 16, gap: 10 }}>
            <Field
              label={uiText("taskTitle")}
              value={editTitle()}
              onChange={editTitle.set}
            />
            <Field
              label={uiText("taskDescription")}
              value={editDescription()}
              onChange={editDescription.set}
              multiline
              style={{ height: 136 }}
            />
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                onPress={() => editing.set(false)}
              />
              <Button
                label={uiText("saveTask")}
                tone="primary"
                disabled={submitting() || !editTitle().trim()}
                onPress={() =>
                  void mutate(async () => {
                    await host.call("tasks", "update", {
                      taskId: props.id,
                      title: editTitle().trim(),
                      description: editDescription(),
                    });
                    editing.set(false);
                  })
                }
              />
            </View>
          </View>
        </Modal>
      </If>
      <If when={archive()}>
        <Modal
          title={
            activeArchiveTargets().length === 1
              ? uiText("isRunningArchivingStopsItsRun", {
                  number: activeArchiveTargets()[0]!.number,
                })
              : activeArchiveTargets().length > 1
                ? uiText("archivingStopsOngoingTaskRunsArchive")
                : uiText("archiveTask")
          }
          phone={phone()}
          overPhoneNavigation
          onClose={() => archive.set(false)}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label size={12} tone="muted">
              {activeArchiveTargets().length
                ? uiText("theRunsStopAndTheTasks")
                : uiText("thisWillPutTheTaskAnd")}
            </Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("keepIt")}
                onPress={() => archive.set(false)}
              />
              <Button
                label={
                  activeArchiveTargets().length
                    ? uiText("stopAndArchive")
                    : uiText("archive")
                }
                tone="primary"
                disabled={submitting()}
                onPress={() => {
                  const stopRuns = activeArchiveTargets().length > 0;
                  void mutate(async () => {
                    await host.call("tasks", "archive", {
                      taskId: props.id,
                      stopRuns,
                    });
                    props.onClose();
                  });
                }}
              />
            </View>
          </View>
        </Modal>
      </If>
      <If when={log()}>
        {(run) => (
          <TaskRunLog
            run={task()?.runs.find((entry) => entry.id === run().id) ?? run()}
            index={
              task()?.runs.findIndex((entry) => entry.id === run().id) ?? 0
            }
            executor={
              host.agent(run().agentId)?.name ?? executor()?.name ?? "Executor"
            }
            layout={props.layout}
            agentId={run().agentId ?? executor()?.id ?? ""}
            nextRunAt={
              task()
                ?.runs.slice(
                  (task()?.runs.findIndex((r) => r.id === run().id) ?? -1) + 1,
                )
                .find((r) => r.sessionId && r.sessionId === run().sessionId)
                ?.startedAt ?? undefined
            }
            onStop={() => stop(run())}
            stopping={submitting()}
            onClose={() => log.set(undefined)}
          />
        )}
      </If>
    </View>
  );
}

function TaskPlan(props: {
  task: () => BoardTaskDetail;
  onOpen: (id: string) => void;
  desktop: boolean;
}) {
  const c = colors();
  const host = useHost();
  const adding = signal(false);
  const prerequisite = signal("");
  const dependent = signal("");
  const addingStep = signal(false);
  const stepTitle = signal("");
  const owner = () =>
    props.task().assigneeAgentId ??
    props.task().createdBy.agentId ??
    host.people()[0]?.id;
  const columnWidth = 164;
  const columnGap = 36;
  const cardHeight = 64;
  const cardGap = 10;
  const saving = signal(false);
  const children = () => {
    const parent = props.task();
    const visible = host.tasks().filter((task) => task.parentId === parent.id);
    const current = new Map(
      (parent.children ?? []).map((task) => [task.taskId, task]),
    );
    for (const { id, number, status, title } of visible)
      current.set(id, { taskId: id, number, status, title });
    return [...current.values()];
  };
  const planDrag = taskDropZones<string>((from, to) => {
    if (
      from === to ||
      saving() ||
      !children().some((child) => child.taskId === to)
    )
      return;
    prerequisite.set(from);
    dependent.set(to);
    void add();
  });
  const graph = () => {
    const references = children();
    const known = new Map(host.tasks().map((task) => [task.id, task]));
    const ids = new Set(references.map((task) => task.taskId));
    const levels = new Map<string, number>();
    const inStack = new Set<string>();
    const parents = new Map<string, string>();
    function level(id: string): number {
      const existing = levels.get(id);
      if (existing !== undefined) return existing;
      if (inStack.has(id)) return 0;
      inStack.add(id);
      const dependencies = (known.get(id)?.dependsOn ?? []).filter((edge) =>
        ids.has(edge.taskId),
      );
      let next = 0;
      for (const edge of dependencies) {
        const depth = level(edge.taskId) + 1;
        if (depth > next) {
          next = depth;
          parents.set(id, edge.taskId);
        }
      }
      inStack.delete(id);
      levels.set(id, next);
      return next;
    }
    const columns: (typeof references)[] = [];
    for (const task of references)
      (columns[level(task.taskId)] ??= []).push(task);
    const points = new Map(
      columns.flatMap((tasks, col) =>
        tasks.map(
          (task, row) =>
            [
              task.taskId,
              {
                x: col * (columnWidth + columnGap),
                y: 18 + cardHeight / 2 + row * (cardHeight + cardGap),
              },
            ] as const,
        ),
      ),
    );
    const critical = new Set<string>();
    let last = columns.at(-1)?.[0]?.taskId;
    while (last && !critical.has(last)) {
      critical.add(last);
      last = parents.get(last);
    }
    const edges = references.flatMap((task) =>
      (known.get(task.taskId)?.dependsOn ?? []).flatMap((edge) => {
        const start = points.get(edge.taskId);
        const end = points.get(task.taskId);
        if (!start || !end || end.x <= start.x) return [];
        return [
          {
            from: start,
            to: end,
            id: `${edge.taskId}/${task.taskId}`,
            primary:
              critical.has(task.taskId) &&
              parents.get(task.taskId) === edge.taskId,
          },
        ];
      }),
    );
    return { columns, edges, critical };
  };
  const steps = () => graph().columns;
  async function appendStep() {
    const assignee = owner();
    if (!assignee || !stepTitle().trim() || saving()) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        parent: props.task().id,
        tasks: [
          {
            title: stepTitle().trim(),
            assignee,
            dependsOn: (steps().at(-1) ?? [])
              .filter((item) => item.status !== "cancelled")
              .map((item) => ({ task: item.taskId })),
          },
        ],
      }),
    );
    saving.set(false);
    if (result) addingStep.set(false);
  }
  async function add() {
    if (
      saving() ||
      !prerequisite() ||
      !dependent() ||
      prerequisite() === dependent()
    )
      return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("tasks", "addDependency", {
        taskId: dependent(),
        dependsOn: prerequisite(),
      }),
    );
    saving.set(false);
    if (result) adding.set(false);
  }
  return (
    <View style={grow}>
      <View style={{ ...row, gap: 8, padding: 14 }}>
        <Label size={12} tone="muted" style={{ flex: 1 }}>
          {uiText("steps", {
            number: props.task().number,
            length: steps().length,
          })}
        </Label>
        <Button
          label={uiText("addDependency")}
          icon="plus"
          onPress={() => {
            prerequisite.set("");
            dependent.set("");
            adding.set(true);
          }}
        />
      </View>
      <Scroll style={grow} horizontal>
        <View style={{ padding: 16, gap: 10 }}>
          <View
            style={{
              position: "relative",
              flexDirection: "row",
              alignItems: "flex-start",
              gap: columnGap,
            }}
          >
            <Each of={graph().edges} key={(edge) => edge.id}>
              {(edge) => {
                const left = () => edge().from.x + columnWidth;
                const width = () => edge().to.x - left();
                const bend = () => left() + width() / 2;
                const tone = () => (edge().primary ? c().ink : c().strong);
                return (
                  <>
                    <View
                      style={{
                        position: "absolute",
                        left: left(),
                        top: edge().from.y,
                        width: width() / 2,
                        height: 1,
                        backgroundColor: tone(),
                      }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        left: bend(),
                        top: Math.min(edge().from.y, edge().to.y),
                        width: 1,
                        height: Math.abs(edge().from.y - edge().to.y) + 1,
                        backgroundColor: tone(),
                      }}
                    />
                    <View
                      style={{
                        position: "absolute",
                        left: bend(),
                        top: edge().to.y,
                        width: width() / 2,
                        height: 1,
                        backgroundColor: tone(),
                      }}
                    />
                  </>
                );
              }}
            </Each>
            <Each of={steps()} key="index">
              {(items, index) => (
                <View style={{ width: columnWidth, gap: cardGap }}>
                  <View
                    style={{
                      ...row,
                      height: 8,
                      justifyContent: "space-between",
                    }}
                  >
                    <Label size={12} weight={600}>
                      {uiText("step", { value1: index() + 1 })}
                    </Label>
                    <Label size={11} tone="muted">
                      {uiText("doneWithCount", {
                        length: items().filter((task) => task.status === "done")
                          .length,
                        value2: items().length,
                      })}
                    </Label>
                  </View>
                  <Each of={items()} key={(task) => task.taskId}>
                    {(task) => {
                      const gesture = planDrag.gesture(task().taskId);
                      return (
                        <View
                          role="button"
                          ref={(view) => planDrag.register(task().taskId, view)}
                          onPress={() => props.onOpen(task().taskId)}
                          style={{
                            ...row,
                            height: cardHeight,
                            padding: 7,
                            gap: 6,
                            borderWidth: 1,
                            borderColor: graph().critical.has(task().taskId)
                              ? c().ink
                              : c().border,
                            backgroundColor: c().canvas,
                            cursor: "pointer",
                          }}
                        >
                          <TaskGlyph status={task().status} />
                          <View style={{ flex: 1, gap: 2 }}>
                            <Label size={12} lines={2}>
                              {task().title}
                            </Label>
                            <Label
                              size={11}
                              tone="muted"
                            >{`#${task().number} · ${statusName(task().status)}`}</Label>
                          </View>
                          <If when={props.desktop}>
                            <View
                              role="button"
                              accessibilityLabel={uiText("taskConnectFrom", {
                                number: task().number,
                              })}
                              onPressDown={gesture.onPressDown}
                              onPanStart={gesture.onPanStart}
                              onPanEnd={gesture.onPanEnd}
                              onPress={() => {
                                prerequisite.set(task().taskId);
                                dependent.set("");
                                adding.set(true);
                              }}
                              style={{
                                width: 14,
                                height: 20,
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "crosshair",
                              }}
                            >
                              <View
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderWidth: 1,
                                  borderRadius: 4,
                                  borderColor: c().muted,
                                  backgroundColor: c().canvas,
                                }}
                              />
                            </View>
                          </If>
                        </View>
                      );
                    }}
                  </Each>
                  <If when={index() === steps().length - 1 && owner()}>
                    <Button
                      label={uiText("addAStepAtTheEnd")}
                      icon="plus"
                      size={32}
                      onPress={() => {
                        stepTitle.set("");
                        addingStep.set(true);
                      }}
                    />
                  </If>
                </View>
              )}
            </Each>
          </View>
          <View style={{ ...row, flexWrap: "wrap", gap: 10, paddingTop: 8 }}>
            <Each of={["done", "in_review", "in_progress", "todo"] as const}>
              {(status) => (
                <View style={{ ...row, gap: 4 }}>
                  <TaskGlyph status={status()} size={11} />
                  <Label size={11} tone="muted">
                    {statusName(status())}
                  </Label>
                </View>
              )}
            </Each>
            <View style={{ ...row, gap: 5 }}>
              <View
                style={{ width: 14, height: 1, backgroundColor: c().ink }}
              />
              <Label size={11} tone="muted">
                {uiText("criticalPath")}
              </Label>
            </View>
          </View>
        </View>
      </Scroll>
      <If when={addingStep()}>
        <Modal
          title={uiText("addAStepAtTheEnd")}
          width={440}
          overPhoneNavigation
          onClose={() => addingStep.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label size={12} tone="muted">
              {uiText("thisTaskWaitsForTheTasks")}
            </Label>
            <Field
              label={uiText("taskTitle")}
              value={stepTitle()}
              onChange={stepTitle.set}
              onSubmit={() => void appendStep()}
            />
            <Button
              label={uiText("addTask")}
              tone="primary"
              disabled={!stepTitle().trim() || saving()}
              onPress={() => void appendStep()}
            />
          </View>
        </Modal>
      </If>
      <If when={adding()}>
        <Modal
          title={uiText("addDependency")}
          width={440}
          onClose={() => adding.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{uiText("chooseTheTaskThatWaitsAnd")}</Label>
            <ActionMenu
              label={uiText("taskThatWaits")}
              value={
                children().find((task) => task.taskId === dependent())?.title ??
                "Select task"
              }
            >
              <Each of={children()} key={(task) => task.taskId}>
                {(task) => (
                  <ActionItem
                    label={task().title}
                    checked={dependent() === task().taskId}
                    onSelect={() => {
                      if (prerequisite() === task().taskId)
                        prerequisite.set("");
                      dependent.set(task().taskId);
                    }}
                  />
                )}
              </Each>
            </ActionMenu>
            <ActionMenu
              label={uiText("prerequisite")}
              value={
                children().find((task) => task.taskId === prerequisite())
                  ?.title ?? "Select prerequisite"
              }
            >
              <Each
                of={children().filter(
                  (task) =>
                    task.taskId !== dependent() && task.status !== "cancelled",
                )}
                key={(task) => task.taskId}
              >
                {(task) => (
                  <ActionItem
                    label={task().title}
                    checked={prerequisite() === task().taskId}
                    onSelect={() => prerequisite.set(task().taskId)}
                  />
                )}
              </Each>
            </ActionMenu>
            <Button
              label={uiText("addDependency")}
              tone="primary"
              disabled={saving() || !prerequisite() || !dependent()}
              onPress={() => void add()}
            />
          </View>
        </Modal>
      </If>
    </View>
  );
}

function isActiveRunStatus(status: TaskRunView["status"]): boolean {
  return status === "queued" || status === "starting" || status === "running";
}

function activeTaskRun(run: TaskRunView): boolean {
  return isActiveRunStatus(run.status);
}

function runCaption(run: TaskRunView, index: number): string {
  const start = run.startedAt ?? run.createdAt;
  const seconds = Math.max(
    0,
    Math.floor(((run.finishedAt ?? Date.now()) - start) / 1000),
  );
  const elapsed =
    seconds < 60
      ? `${seconds}s`
      : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `Run ${index + 1} · ${elapsed}`;
}

function taskActivityLabel(entry: TaskActivityView): string {
  if (entry.kind === "status") {
    const next = entry.data.to as BoardTaskStatus;
    if (Object.hasOwn(statusKeys, next)) return `moved to ${statusName(next)}`;
  }
  if (entry.kind === "dependency") {
    const edge = dependencyEntry(entry.data);
    if (edge) {
      if (edge.action === "unblocked") return "unblocked";
      const ref = `#${edge.number}`;
      if (edge.action === "added") return `waiting for ${ref}`;
      if (edge.action === "blocked") return `blocked by ${ref}`;
      return `dependency ${ref} ${
        edge.action === "required" ? "updated" : edge.action
      }`;
    }
  }
  return entry.kind.replaceAll("_", " ");
}

function TaskRunLog(props: {
  run: TaskRunView;
  index: number;
  executor: string;
  agentId: string;
  layout: Layout;
  nextRunAt?: number;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  return (
    <Modal
      title={`${runCaption(props.run, props.index)} · ${props.executor}`}
      width={
        props.layout === "desktop" ? 960 : Math.max(0, windowSize().width - 144)
      }
      height={
        phone()
          ? "100%"
          : Math.max(
              0,
              windowSize().height - (props.layout === "desktop" ? 100 : 48),
            )
      }
      phone={phone()}
      phonePage={phone()}
      hideHeader={!phone() && !!props.run.sessionId}
      modalFocus
      blurBackdrop={props.layout === "desktop"}
      overPhoneNavigation
      onClose={props.onClose}
    >
      <If
        when={props.run.sessionId}
        else={
          <View style={{ ...grow, padding: 16, gap: 8 }}>
            <Label size={12} tone={props.run.error ? "red" : "muted"}>
              {props.run.error ??
                (props.run.status === "queued"
                  ? uiText("awaitingTaskSession")
                  : uiText("noLogEntriesYet"))}
            </Label>
          </View>
        }
      >
        {(session) => (
          <MemberRun
            session={session()}
            agentId={props.agentId}
            executorName={props.executor}
            taskRun={props.run}
            nextRunAt={props.nextRunAt}
            phone={phone()}
            onClose={props.onClose}
          />
        )}
      </If>
      <If when={activeTaskRun(props.run)}>
        <View
          style={{
            ...row,
            paddingHorizontal: 16,
            minHeight: 42,
            gap: 8,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label size={12} tone="muted" style={{ flex: 1 }}>
            {uiText("readOnlyReplyOnTheTask", { executor: props.executor })}
          </Label>
          <Button
            label={uiText("stop")}
            disabled={props.stopping}
            onPress={props.onStop}
          />
        </View>
      </If>
    </Modal>
  );
}

export function NewTask(props: {
  phone: boolean;
  conversation?: string;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const title = signal("");
  const description = signal("");
  const agent = signal("");
  const conversation = signal(props.conversation ?? "");
  const backlog = signal(false);
  const busy = signal(false);
  const groups = () =>
    host
      .conversations()
      .filter((item) => item.kind === "group" && !item.archived);
  async function save() {
    if (busy() || !agent() || !title().trim()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        tasks: [
          {
            title: title().trim(),
            description: description().trim(),
            assignee: agent(),
          },
        ],
        status: backlog() ? "backlog" : "todo",
        conversationId: conversation() || undefined,
      }),
    );
    busy.set(false);
    if (result?.tasks[0]) {
      props.onClose();
      props.onOpen(result.tasks[0].id);
    }
  }
  return (
    <Modal
      title={uiText("newTask")}
      width={540}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 10 }}>
        <Field
          label={uiText("title")}
          placeholder={uiText("taskTitle")}
          value={title()}
          onChange={title.set}
        />
        <Field
          label={uiText("description")}
          placeholder={uiText("describeTheWork")}
          value={description()}
          multiline
          onChange={description.set}
          style={{ height: 72 }}
        />
        <Caption text={uiText("executor")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 6 }}>
          <Each of={host.people()} key={(entry) => entry.id}>
            {(entry) => (
              <Button
                label={entry().name}
                selected={agent() === entry().id}
                onPress={() => agent.set(entry().id)}
              />
            )}
          </Each>
        </View>
        <Caption text={uiText("conversation")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 6 }}>
          <Button
            label={uiText("none")}
            selected={!conversation()}
            onPress={() => conversation.set("")}
          />
          <Each of={groups()} key={(entry) => entry.id}>
            {(entry) => (
              <Button
                label={entry().name}
                selected={conversation() === entry().id}
                onPress={() => conversation.set(entry().id)}
              />
            )}
          </Each>
        </View>
        <View style={{ ...row, gap: 6, justifyContent: "flex-end" }}>
          <Button
            label={uiText("backlog")}
            selected={backlog()}
            onPress={() => backlog.set(!backlog())}
          />
          <Button
            label={uiText("createTask")}
            tone="primary"
            disabled={!title().trim() || !agent() || busy()}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}
