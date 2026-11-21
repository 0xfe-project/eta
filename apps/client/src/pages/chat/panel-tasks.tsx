import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Caption, colors, Icon, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { runAgo } from "../routines/schedule";
import {
  statusName,
  SubtaskSegments,
  subtasksOf,
  TaskGlyph,
  TaskStatus,
} from "../tasks/status";

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
        <Label size={10} line={12} tone="muted">
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
            <Label size={11} line={14} tone="muted">
              {`#${entry().task.number}`}
            </Label>
            <Label size={12} line={16} lines={1} style={{ flex: 1 }}>
              {entry().task.title}
            </Label>
            <If
              when={entry().task.subtasks?.total}
              else={<TaskStatus task={entry().task} />}
            >
              <SubtaskSegments
                subtasks={subtasksOf(host.tasks(), entry().task)}
              />
              <Label size={11} line={14} tone="muted">
                {`${entry().task.subtasks?.done ?? 0}/${entry().task.subtasks?.total ?? 0}`}
              </Label>
            </If>
            <Icon name="right" size={10} tone="muted" />
          </View>
        )}
      </Each>
      <If when={!props.tasks.length}>
        <Label
          size={12}
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

const folded = [
  ["done", "taskCompletedCount"],
  ["cancelled", "taskCancelledCount"],
] as const;

/** The Tasks tab: this group's tasks (or every group's) by what they need. */
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
        size={11}
        line={16}
        weight={selected ? 600 : 400}
        tone={selected ? "ink" : "muted"}
        lines={1}
      >
        {label}
      </Label>
    </View>
  );
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 12 }}>
      <Label weight={600} line={20} style={{ paddingBottom: 8 }}>
        {uiText("tasks2")}
      </Label>
      <View style={{ ...row, gap: 6, paddingBottom: 12 }}>
        {scope(props.conversationName, !everywhere(), () =>
          everywhere.set(false),
        )}
        {scope(uiText("allGroups"), everywhere(), () => everywhere.set(true))}
      </View>
      <Each of={sections}>
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
                size={11}
                line={16}
                tone="muted"
                style={{ paddingTop: index() ? 10 : 2, paddingBottom: 6 }}
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
                  cursor: "pointer",
                }}
              >
                <Icon
                  name={expanded() ? "down" : "right"}
                  size={8}
                  tone="muted"
                />
                <TaskGlyph status={group()[0]} size={12} />
                <Label size={11} line={16}>
                  {uiText(group()[1], { count: items().length })}
                </Label>
              </View>
              <If when={expanded()}>
                <Each of={items()} key={(task) => task.id}>
                  {(task) => (
                    <TaskRow
                      task={task()}
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
        <Label size={12} tone="muted">
          {uiText("noTasksYet")}
        </Label>
      </If>
    </View>
  );
}

function TaskRow(props: { task: BoardTaskView; onPress: () => void }) {
  const host = useHost();
  const c = colors();
  const task = () => props.task;
  const executor = () =>
    host.agent(task().assigneeAgentId ?? task().createdBy.agentId)?.name;
  const meta = () =>
    [`#${task().number}`, executor(), runAgo(task().updatedAt)]
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
      style={{ ...row, height: 52, gap: 10, flexShrink: 0, cursor: "pointer" }}
    >
      <TaskGlyph status={task().status} size={14} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Label size={13} line={18} lines={1}>
          {task().title}
        </Label>
        <Label size={10} line={14} tone="muted" lines={1}>
          {meta()}
        </Label>
      </View>
      <If when={task().subtasks?.total}>
        <SubtaskSegments
          subtasks={subtasksOf(host.tasks(), task())}
          width={6}
        />
        <Label size={11} line={16} tone="muted">
          {`${task().subtasks?.done ?? 0}/${task().subtasks?.total ?? 0}`}
        </Label>
      </If>
      <If when={!task().subtasks?.total}>
        <If when={waitingFor()}>
          {(wait) => (
            <View style={{ ...row, gap: 4, flexShrink: 1, maxWidth: 160 }}>
              <Icon name="lock" size={11} tone="muted" />
              <Label size={11} line={16} tone="muted" lines={1}>
                {wait().title}
              </Label>
            </View>
          )}
        </If>
        <If when={task().status === "in_progress"}>
          <View style={{ ...row, gap: 4 }}>
            <StatusDot color={c().blue} />
            <Label size={11} line={16} tone="blue">
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
          <Label size={11} line={16} tone="muted">
            {statusName(task().status)}
          </Label>
        </If>
      </If>
    </View>
  );
}
