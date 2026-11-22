import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { TaskPanelSort } from "./panel-sort";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Caption,
  colors,
  Icon,
  Label,
  row,
  Screen,
} from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskTime } from "../tasks/facts";
import {
  statusName,
  SubtaskSegments,
  subtasksOf,
  TaskGlyph,
  TaskStatus,
} from "../tasks/status";
import { cardUsage, UsageLine, usageShown, useLiveRate } from "../tasks/usage";
import { setTaskPanelSort, taskPanelSort } from "./panel-sort";

const closed = (task: BoardTaskView) =>
  task.status === "done" || task.status === "cancelled";

/** Tasks as a tree: each parent, by number, followed by its subtasks. */
function taskTree(tasks: BoardTaskView[]) {
  const ids = new Set(tasks.map((task) => task.id));
  const sorted = [...tasks].sort((a, b) => a.number - b.number);
  const rows: { task: BoardTaskView; depth: number }[] = [];
  const visit = (task: BoardTaskView, depth: number) => {
    rows.push({ task, depth });
    for (const child of sorted.filter((entry) => entry.parentId === task.id))
      visit(child, depth + 1);
  };
  for (const task of sorted)
    if (!task.parentId || !ids.has(task.parentId)) visit(task, 0);
  return rows;
}

/** The Context tab's Tasks section: open tasks, subtasks under their parent. */
export function ContextTasks(props: {
  tasks: BoardTaskView[];
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const open = () => props.tasks.filter((task) => !closed(task));
  const rows = () => taskTree(open()).slice(0, 6);
  return (
    <View>
      <View
        style={{
          ...row,
          gap: 6,
          paddingTop: 10,
          paddingBottom: 4,
          paddingHorizontal: 12,
        }}
      >
        <Caption text={uiText("tasks2")} />
        <Label variant="caption" tone="muted">
          {open().length}
        </Label>
      </View>
      <Each of={rows()} key={(entry) => entry.task.id}>
        {(entry) => (
          <View
            role="button"
            accessibilityLabel={entry().task.title}
            onPress={() => props.onTask(entry().task.id)}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              height: 30,
              paddingLeft: entry().depth ? 22 : 10,
              paddingRight: 10,
              gap: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={entry().task.status} size={14} />
            <Label variant="caption" tone="muted">
              {`#${entry().task.number}`}
            </Label>
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {entry().task.title}
            </Label>
            <If
              when={entry().task.subtasks?.total}
              else={<TaskStatus task={entry().task} />}
            >
              <SubtaskSegments
                subtasks={subtasksOf(host.tasks(), entry().task)}
              />
              <Label variant="caption" tone="muted">
                {`${entry().task.subtasks?.done ?? 0}/${entry().task.subtasks?.total ?? 0}`}
              </Label>
            </If>
            <Icon name="right" size={10} tone="muted" />
          </View>
        )}
      </Each>
      <If when={!props.tasks.length}>
        <Label
          variant="small"
          tone="muted"
          style={{ paddingHorizontal: 12, paddingBottom: 8 }}
        >
          {uiText("noTasksYet")}
        </Label>
      </If>
    </View>
  );
}

const sections = [
  ["taskNeedsYou", ["in_review", "blocked"]],
  ["taskSectionGoing", ["in_progress"]],
  ["taskSectionWaiting", ["todo", "backlog"]],
] as const satisfies readonly (readonly [
  Parameters<typeof uiText>[0],
  readonly BoardTaskStatus[],
])[];

/** The Tasks tab's side inset, on each part rather than the whole, so rows can reach both edges. */
const inset = 10;

const folded = [
  ["done", "taskCompletedCount"],
  ["cancelled", "taskCancelledCount"],
] as const;

const sortNames = {
  needs: "tasksSortNeedsYou",
  updated: "tasksSortUpdated",
} as const satisfies Record<TaskPanelSort, Parameters<typeof uiText>[0]>;

/**
 * The Tasks tab: this group's tasks (or every group's) by what they need, or, sorted by Recently
 * updated, the open ones in one list by when they last changed. Done and cancelled stay folded
 * under either sort.
 */
export function TasksTab(props: {
  conversationId: string;
  conversationName: string;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const everywhere = signal(false);
  const open = signal<BoardTaskStatus[]>([]);
  const tasks = () =>
    host
      .tasks()
      .filter(
        (task) =>
          !task.archivedAt &&
          (everywhere() || task.conversationId === props.conversationId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const scope = (label: string, selected: boolean, onPress: () => void) => (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        paddingVertical: 2,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderColor: selected ? c().ink : c().border,
        cursor: "pointer",
      }}
    >
      <Label
        variant="small"
        weight={selected ? 600 : 400}
        tone={selected ? "ink" : "muted"}
        lines={1}
      >
        {label}
      </Label>
    </View>
  );
  return (
    // No side padding here: each part carries its own, so the rows can reach both edges.
    <View style={{ paddingTop: 12 }}>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: 8,
          paddingBottom: 8,
          paddingHorizontal: inset,
        }}
      >
        <Label weight={600} style={{ flexShrink: 0 }}>
          {uiText("tasks2")}
        </Label>
        {/* The /tasks list's "Group: …" menu, on the title's line so the scopes keep their row. */}
        <ActionMenu
          label={uiText("tasksSortBy")}
          sheetTitle={uiText("tasksSortBy")}
          value={uiText("tasksSorting", {
            name: uiText(sortNames[taskPanelSort()]),
          })}
          valueTone="muted"
          truncateValue
          triggerStyle={{
            borderWidth: 0,
            height: 23,
            marginVertical: -4,
            marginRight: -6,
            paddingHorizontal: 6,
            gap: 5,
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          <Each of={["needs", "updated"] as const}>
            {(sort) => (
              <ActionItem
                label={uiText(sortNames[sort()])}
                checked={taskPanelSort() === sort()}
                onSelect={() => setTaskPanelSort(sort())}
              />
            )}
          </Each>
        </ActionMenu>
      </View>
      <View
        style={{ ...row, gap: 6, paddingBottom: 12, paddingHorizontal: inset }}
      >
        {scope(props.conversationName, !everywhere(), () =>
          everywhere.set(false),
        )}
        {scope(uiText("allGroups"), everywhere(), () => everywhere.set(true))}
      </View>
      <If when={taskPanelSort() === "updated"}>
        <View style={{ height: 2 }} />
        <Each
          of={tasks().filter((task) => !closed(task))}
          key={(task) => task.id}
        >
          {(task) => (
            <TaskRow
              task={task()}
              timeFirst
              onPress={() => props.onTask(task().id)}
            />
          )}
        </Each>
      </If>
      <Each of={taskPanelSort() === "needs" ? sections : []}>
        {(section, index) => {
          const items = () =>
            tasks().filter((task) =>
              (section()[1] as readonly BoardTaskStatus[]).includes(
                task.status,
              ),
            );
          return (
            <If when={items().length}>
              <Label
                variant="small"
                tone="muted"
                style={{
                  paddingTop: index() ? 10 : 2,
                  paddingBottom: 6,
                  paddingHorizontal: inset,
                }}
              >
                {`${uiText(section()[0])} ${items().length}`}
              </Label>
              <Each of={items()} key={(task) => task.id}>
                {(task) => (
                  <TaskRow
                    task={task()}
                    onPress={() => props.onTask(task().id)}
                  />
                )}
              </Each>
            </If>
          );
        }}
      </Each>
      <Each of={folded}>
        {(group, index) => {
          const items = () =>
            tasks().filter((task) => task.status === group()[0]);
          const expanded = () => open().includes(group()[0]);
          return (
            <If when={items().length}>
              <View
                role="button"
                accessibilityState={{ expanded: expanded() }}
                onPress={() =>
                  open.set(
                    expanded()
                      ? open().filter((status) => status !== group()[0])
                      : [...open(), group()[0]],
                  )
                }
                style={{
                  ...row,
                  height: 28,
                  gap: 8,
                  paddingTop: index() ? 0 : 6,
                  paddingHorizontal: inset,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={expanded() ? "down" : "right"}
                  size={8}
                  tone="muted"
                />
                <TaskGlyph status={group()[0]} size={12} />
                <Label variant="small">
                  {uiText(group()[1], { count: items().length })}
                </Label>
              </View>
              <If when={expanded()}>
                <Each of={items()} key={(task) => task.id}>
                  {(task) => (
                    <TaskRow
                      task={task()}
                      timeFirst={taskPanelSort() === "updated"}
                      onPress={() => props.onTask(task().id)}
                    />
                  )}
                </Each>
              </If>
            </If>
          );
        }}
      </Each>
      <If when={!tasks().length}>
        <Label
          variant="small"
          tone="muted"
          style={{ paddingHorizontal: inset }}
        >
          {uiText("noTasksYet")}
        </Label>
      </If>
    </View>
  );
}

/** The live rate of a task's run going on eta's own loop, before its running time. */
function PanelRate(props: { task: BoardTaskView }) {
  const rate = useLiveRate(() =>
    usageShown() ? props.task.usage?.liveSessionId : undefined,
  );
  return (
    <If when={rate()}>
      {(value) => (
        <Label variant="small" tone="green" style={{ flexShrink: 0 }}>
          {uiText("usageRate", { rate: value().toFixed(1) })}
        </Label>
      )}
    </If>
  );
}

function TaskRow(props: {
  task: BoardTaskView;
  /** Sorted by Recently updated: the time leads the second line, in ink. */
  timeFirst?: boolean;
  onPress: () => void;
}) {
  const layout = Screen();
  const host = useHost();
  const c = colors();
  const task = () => props.task;
  const executor = () =>
    host.agent(task().assigneeAgentId ?? task().createdBy.agentId)?.name;
  // `taskTime`, not the routines' `runAgo`: that one needs `Intl.RelativeTimeFormat`, which the
  // native runtime (macOS, Linux, Windows, phones) does not have, and its throw took the line.
  const meta = () =>
    (props.timeFirst
      ? [`#${task().number}`, executor()]
      : [`#${task().number}`, executor(), taskTime(task())]
    )
      .filter(Boolean)
      .join(" · ");
  const waitingFor = () =>
    task().status === "todo" ? task().waitingOn?.[0] : undefined;
  const minutes = () =>
    Math.max(0, Math.floor((Date.now() - task().updatedAt) / 60_000));
  return (
    <View
      role="button"
      accessibilityLabel={task().title}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 52,
        gap: 10,
        flexShrink: 0,
        paddingHorizontal: inset,
        cursor: "pointer",
      }}
    >
      <TaskGlyph status={task().status} size={14} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label variant="small" lines={1}>
          {task().title}
        </Label>
        <View style={{ ...row, minWidth: 0 }}>
          <If when={props.timeFirst}>
            <Label variant="caption" lines={1} style={{ flexShrink: 0 }}>
              {taskTime(task())}
            </Label>
            <Label
              variant="caption"
              tone="muted"
              style={{ flexShrink: 0, marginHorizontal: 4 }}
            >
              ·
            </Label>
          </If>
          <Label
            variant="caption"
            tone="muted"
            lines={1}
            style={{ flexShrink: 0 }}
          >
            {meta()}
          </Label>
          <If when={usageShown() && cardUsage(task())}>
            <Label
              variant="caption"
              tone="muted"
              style={{ flexShrink: 0, marginHorizontal: 4 }}
            >
              ·
            </Label>
            <UsageLine
              task={task()}
              variant="caption"
              model={layout() === "desktop"}
              tone="mutedInk"
              style={{ flexShrink: 1 }}
            />
          </If>
        </View>
      </View>
      <If when={!task().subtasks?.total}>
        <PanelRate task={task()} />
      </If>
      <If when={task().subtasks?.total}>
        <SubtaskSegments
          subtasks={subtasksOf(host.tasks(), task())}
          width={6}
        />
        <Label variant="small" tone="muted">
          {`${task().subtasks?.done ?? 0}/${task().subtasks?.total ?? 0}`}
        </Label>
      </If>
      <If when={!task().subtasks?.total}>
        <If when={waitingFor()}>
          {(wait) => (
            <View style={{ ...row, gap: 4, flexShrink: 1, maxWidth: 160 }}>
              <Icon name="lock" size={11} tone="muted" />
              <Label variant="small" tone="muted" lines={1}>
                {wait().title}
              </Label>
            </View>
          )}
        </If>
        <If when={task().status === "in_progress"}>
          <View style={{ ...row, gap: 4 }}>
            <StatusDot color={c().blue} />
            <Label variant="small" tone="blue">
              {uiText("minutesShort", { count: minutes() })}
            </Label>
          </View>
        </If>
        <If
          when={
            task().status === "in_review" ||
            task().status === "blocked" ||
            task().status === "done" ||
            task().status === "cancelled"
          }
        >
          <TaskStatus task={task()} />
        </If>
        <If when={task().status === "todo" && !waitingFor()}>
          <Label variant="small" tone="muted">
            {statusName(task().status)}
          </Label>
        </If>
      </If>
    </View>
  );
}
