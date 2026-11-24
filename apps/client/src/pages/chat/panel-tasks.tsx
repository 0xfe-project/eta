import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { TaskPanelSort } from "./panel-sort";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Icon,
  Label,
  row,
  Screen,
} from "../../components";
import { dotSize, StatusDot } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
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
import {
  latestChange,
  needingYou,
  parentOpen,
  setParentOpen,
  taskRoots,
  treeRows,
} from "./panel-tree";
import { SectionHeading, ViewAll } from "./section-heading";

const closed = (task: BoardTaskView) =>
  task.status === "done" || task.status === "cancelled";

/** A parent's fold: its subtasks under it, or not. */
export function SubtaskToggle(props: {
  task: BoardTaskView;
  open: boolean;
  onToggle: () => void;
  /** The side of its square: bigger on a phone, for a thumb. */
  size?: number;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={uiText(props.open ? "subtasksHide" : "subtasksShow", {
        title: props.task.title,
      })}
      accessibilityState={{ expanded: props.open }}
      onPress={props.onToggle}
      hoverStyle={{ backgroundColor: c().strong }}
      style={{
        ...row,
        justifyContent: "center",
        width: props.size ?? 24,
        height: props.size ?? 24,
        marginRight: -6,
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      <View
        style={{ transform: props.open ? [{ rotate: "180deg" }] : undefined }}
      >
        <Icon name="down" size={10} tone="muted" />
      </View>
    </View>
  );
}

/** A parent's progress: a segment per subtask, then how many are done. */
export function SubtaskProgress(props: {
  task: BoardTaskView;
  width?: number;
}) {
  const host = useHost();
  return (
    <>
      <SubtaskSegments
        subtasks={subtasksOf(host.tasks(), props.task)}
        width={props.width}
      />
      <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
        {`${props.task.subtasks?.done ?? 0}/${props.task.subtasks?.total ?? 0}`}
      </Label>
    </>
  );
}

/** A task's row in the context panel's list. */
const contextRowHeight = 32;

/** The Context tab's Tasks section: open tasks, each parent folded over its subtasks. */
export function ContextTasks(props: {
  tasks: BoardTaskView[];
  onTask: (id: string) => void;
  /** To the Tasks tab, which also lists the closed ones and those past the first few. */
  onViewAll: () => void;
}) {
  const host = useHost();
  const c = colors();
  const open = () =>
    taskRoots(
      props.tasks.filter((task) => !closed(task)),
      host.tasks(),
    );
  // The Tasks tab lists every unarchived task: offered when that is more than shown here.
  const listed = () =>
    taskRoots(
      props.tasks.filter((task) => !task.archivedAt),
      host.tasks(),
    ).roots;
  const shown = () =>
    [...open().roots].sort((a, b) => a.number - b.number).slice(0, 6);
  const rows = () => treeRows(shown(), open().revealed, host.tasks());
  return (
    <View>
      <SectionHeading label={uiText("tasks2")} count={open().roots.length}>
        <If when={listed().length > shown().length}>
          <ViewAll label={uiText("tasksViewAll")} onPress={props.onViewAll} />
        </If>
      </SectionHeading>
      <Each of={rows()} key={(entry) => entry.task.id}>
        {(entry) => (
          <View
            role="button"
            accessibilityLabel={entry().task.title}
            onPress={() => props.onTask(entry().task.id)}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              height: contextRowHeight,
              paddingLeft: space[12] + entry().depth * 22,
              paddingRight: space[12],
              gap: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={entry().task.status} size={icon.sm} />
            <Label variant="caption" tone="muted">
              {`#${entry().task.number}`}
            </Label>
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {entry().task.title}
            </Label>
            <If
              when={entry().parent}
              else={
                <>
                  <TaskStatus task={entry().task} />
                  <Icon name="right" size={icon.sm} tone="muted" />
                </>
              }
            >
              <If
                when={!entry().open && needingYou(entry().task, host.tasks())}
              >
                <StatusDot color={c().warning} />
              </If>
              <SubtaskProgress task={entry().task} />
              <SubtaskToggle
                task={entry().task}
                open={entry().open}
                onToggle={() => setParentOpen(entry().task.id, !entry().open)}
              />
            </If>
          </View>
        )}
      </Each>
      <If when={!props.tasks.length}>
        <Label
          variant="small"
          tone="muted"
          style={{
            paddingHorizontal: space[12],
            paddingBottom: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
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
const inset = space[12];

/** A task's row in the Tasks tab, and how far the line naming what it waits for runs. */
const taskRowHeight = 52;
const waitingWidth = 160;

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
  // Parents with their subtasks under them, placed and ordered as one: by the parent's status (its
  // subtasks' own), and by when anything in it last changed.
  const tree = () => taskRoots(tasks(), host.tasks());
  const roots = () => {
    const all = host.tasks();
    return tree()
      .roots.map((task) => ({ task, at: latestChange(task, all) }))
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.task);
  };
  const branch = (task: BoardTaskView, timeFirst?: boolean) => (
    <TaskBranch
      task={task}
      depth={0}
      revealed={tree().revealed}
      timeFirst={timeFirst}
      onTask={props.onTask}
    />
  );
  const scope = (label: string, selected: boolean, onPress: () => void) => (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        paddingVertical: space[2],
        paddingHorizontal: space[8],
        borderWidth: 1,
        borderColor: selected ? c().ink : c().border,
        cursor: "pointer",
      }}
    >
      <Label
        variant="small"
        weight={selected ? weight.strong : weight.regular}
        tone={selected ? "ink" : "muted"}
        lines={1}
      >
        {label}
      </Label>
    </View>
  );
  return (
    // No side padding here: each part carries its own, so the rows can reach both edges.
    <View style={{ paddingTop: space[12] }}>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          gap: space[8],
          paddingBottom: space[8],
          paddingHorizontal: inset,
        }}
      >
        <Label weight={weight.strong} style={{ flexShrink: 0 }}>
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
            height: control.sm,
            marginVertical: -space[4],
            marginRight: -space[8],
            paddingHorizontal: space[8],
            gap: space[4],
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
        style={{
          ...row,
          gap: space[4],
          paddingBottom: space[12],
          paddingHorizontal: inset,
        }}
      >
        {scope(props.conversationName, !everywhere(), () =>
          everywhere.set(false),
        )}
        {scope(uiText("allGroups"), everywhere(), () => everywhere.set(true))}
      </View>
      <If when={taskPanelSort() === "updated"}>
        <View style={{ height: space[2] }} />
        <Each
          of={roots().filter((task) => !closed(task))}
          key={(task) => task.id}
        >
          {(task) => branch(task(), true)}
        </Each>
      </If>
      <Each of={taskPanelSort() === "needs" ? sections : []}>
        {(section, index) => {
          const items = () =>
            roots().filter((task) =>
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
                  paddingTop: index() ? space[12] : space[2],
                  paddingBottom: space[8],
                  paddingHorizontal: inset,
                }}
              >
                {`${uiText(section()[0])} ${items().length}`}
              </Label>
              <Each of={items()} key={(task) => task.id}>
                {(task) => branch(task())}
              </Each>
            </If>
          );
        }}
      </Each>
      <Each of={folded}>
        {(group, index) => {
          const items = () =>
            roots().filter((task) => task.status === group()[0]);
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
                  height: control.md,
                  gap: space[8],
                  paddingTop: index() ? 0 : space[8],
                  paddingHorizontal: inset,
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={expanded() ? "down" : "right"}
                  size={icon.sm}
                  tone="muted"
                />
                <TaskGlyph status={group()[0]} size={icon.sm} />
                <Label variant="small">
                  {uiText(group()[1], { count: items().length })}
                </Label>
              </View>
              <If when={expanded()}>
                <Each of={items()} key={(task) => task.id}>
                  {(task) => branch(task(), taskPanelSort() === "updated")}
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

/** A task and, when it is open, its subtasks under it, each its own branch. */
function TaskBranch(props: {
  task: BoardTaskView;
  depth: number;
  revealed: Set<string>;
  timeFirst?: boolean | undefined;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const children = () => subtasksOf(host.tasks(), props.task);
  const open = () =>
    parentOpen(props.task.id, props.revealed.has(props.task.id));
  const toggle = () =>
    children().length
      ? { open: open(), onToggle: () => setParentOpen(props.task.id, !open()) }
      : undefined;
  return (
    <>
      <If
        when={props.depth === 0}
        else={
          <SubtaskRow
            task={props.task}
            depth={props.depth}
            toggle={toggle()}
            onPress={() => props.onTask(props.task.id)}
          />
        }
      >
        <TaskRow
          task={props.task}
          timeFirst={props.timeFirst}
          toggle={toggle()}
          onPress={() => props.onTask(props.task.id)}
        />
      </If>
      <If when={open() && children().length}>
        <Each of={children()} key={(task) => task.id}>
          {(child) => (
            <TaskBranch
              task={child()}
              depth={props.depth + 1}
              revealed={props.revealed}
              onTask={props.onTask}
            />
          )}
        </Each>
      </If>
    </>
  );
}

/** A subtask under its open parent: its mark, number, title and status, a step in. */
function SubtaskRow(props: {
  task: BoardTaskView;
  depth: number;
  toggle?: { open: boolean; onToggle: () => void } | undefined;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.task.title}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 34,
        gap: 8,
        flexShrink: 0,
        // Under the parent's title: the inset, its 14px mark and the 10px gap, a step per level.
        paddingLeft: inset + 24 * props.depth,
        paddingRight: inset,
        cursor: "pointer",
      }}
    >
      <TaskGlyph status={props.task.status} size={12} />
      <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
        {`#${props.task.number}`}
      </Label>
      <Label variant="small" lines={1} style={{ flex: 1 }}>
        {props.task.title}
      </Label>
      <If when={props.toggle} else={<TaskStatus task={props.task} />}>
        {(toggle) => (
          <>
            <SubtaskProgress task={props.task} />
            <SubtaskToggle
              task={props.task}
              open={toggle().open}
              onToggle={toggle().onToggle}
            />
          </>
        )}
      </If>
    </View>
  );
}

function TaskRow(props: {
  task: BoardTaskView;
  /** Sorted by Recently updated: the time leads the second line, in ink. */
  timeFirst?: boolean | undefined;
  /** A parent's fold, beside its progress. */
  toggle?: { open: boolean; onToggle: () => void } | undefined;
  onPress: () => void;
}) {
  const layout = Screen();
  const host = useHost();
  const c = colors();
  const task = () => props.task;
  // A parent's time is its newest subtask's: what moved in it last.
  const changed = () =>
    taskTime({ ...task(), updatedAt: latestChange(task(), host.tasks()) });
  const waiting = () =>
    props.toggle && !props.toggle.open ? needingYou(task(), host.tasks()) : 0;
  const executor = () =>
    host.agent(task().assigneeAgentId ?? task().createdBy.agentId)?.name;
  // `taskTime`, not the routines' `runAgo`: that one needs `Intl.RelativeTimeFormat`, which the
  // native runtime (macOS, Linux, Windows, phones) does not have, and its throw took the line.
  const meta = () =>
    (props.timeFirst
      ? [`#${task().number}`, executor()]
      : [`#${task().number}`, executor(), changed()]
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
        height: taskRowHeight,
        gap: space[8],
        flexShrink: 0,
        paddingHorizontal: inset,
        // A line under every row, as the Context tab's rows: the row reaches both edges, so the
        // line and the hover do too. A group's heading has none, so its first row has one line.
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <TaskGlyph status={task().status} size={icon.sm} />
      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
        <Label variant="small" lines={1}>
          {task().title}
        </Label>
        <View style={{ ...row, minWidth: 0 }}>
          <If when={props.timeFirst}>
            <Label variant="caption" lines={1} style={{ flexShrink: 0 }}>
              {changed()}
            </Label>
            <Label
              variant="caption"
              tone="muted"
              style={{ flexShrink: 0, marginHorizontal: space[4] }}
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
          <If when={waiting()}>
            <Label
              variant="caption"
              tone="muted"
              style={{ flexShrink: 0, marginHorizontal: 4 }}
            >
              ·
            </Label>
            <Label variant="caption" tone="warning" style={{ flexShrink: 0 }}>
              {uiText("subtasksNeedYou", { count: waiting() })}
            </Label>
          </If>
          <If when={usageShown() && cardUsage(task())}>
            <Label
              variant="caption"
              tone="muted"
              style={{ flexShrink: 0, marginHorizontal: space[4] }}
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
        <SubtaskProgress task={task()} width={dotSize} />
      </If>
      <If when={props.toggle}>
        {(toggle) => (
          <SubtaskToggle
            task={task()}
            open={toggle().open}
            onToggle={toggle().onToggle}
          />
        )}
      </If>
      <If when={!task().subtasks?.total}>
        <If when={waitingFor()}>
          {(wait) => (
            <View
              style={{
                ...row,
                gap: space[4],
                flexShrink: 1,
                maxWidth: waitingWidth,
              }}
            >
              <Icon name="lock" size={icon.sm} tone="muted" />
              <Label variant="small" tone="muted" lines={1}>
                {wait().title}
              </Label>
            </View>
          )}
        </If>
        <If when={task().status === "in_progress"}>
          <View style={{ ...row, gap: space[4] }}>
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
