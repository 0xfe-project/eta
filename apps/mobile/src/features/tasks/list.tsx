import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import { computed, Scroll, signal, Text, View } from "nsh";
import { boardTasks, conversations } from "../../app/lists";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { ago } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { Empty } from "../../ui/States";
import { useTarget } from "../../wire/target";
import {
  actorName,
  executor,
  FOLDED_STATUSES,
  isActive,
  OPEN_STATUSES,
  past,
  runLabel,
  STATUS_ICONS,
  statusColor,
  statusLabel,
} from "./format";

/** How many rows a fold shows before 还有 N 条. */
const FOLD_ROWS = 2;

/** The stacked strip under the title: how the open work divides. */
const BAR: { status: BoardTaskStatus; class: string }[] = [
  { status: "in_review", class: "bg-foreground" },
  { status: "in_progress", class: "bg-border-strong" },
  { status: "blocked", class: "bg-state-error" },
  { status: "todo", class: "bg-muted" },
];

/** Whether the latest run is underway or failed; a finished one leaves it to the task's status. */
function RunState(props: { task: BoardTaskView }) {
  const status = () => props.task.runStatus;
  return (
    <>
      <If when={isActive(status())}>
        <View class="flex-row items-center gap-1">
          <Icon
            name={status() === "queued" ? "clock" : "spinner"}
            size={13}
            color={status() === "queued" ? "muted-foreground" : "foreground"}
          />
          <Text
            class={`text-sm leading-4 ${status() === "queued" ? "text-muted-foreground" : "text-foreground"}`}
          >
            {runLabel(status() ?? "queued")}
          </Text>
        </View>
      </If>
      <If when={status() === "failed"}>
        <Text class="text-sm leading-4 text-state-error">
          {runLabel("failed")}
        </Text>
      </If>
    </>
  );
}

function TaskRow(props: { task: BoardTaskView }) {
  const meta = () => {
    const task = props.task;
    const base = `#${task.number} · ${actorName(executor(task))}`;
    return task.status === "todo" && task.runStatus === null
      ? `${base} · ${t("tasks.run.never")}`
      : base;
  };
  return (
    <View
      role="button"
      testID={`task-${props.task.number}`}
      accessibilityLabel={props.task.title}
      onPress={() => go.task(props.task.id)}
      class="h-[60px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
    >
      <Icon
        name={STATUS_ICONS[props.task.status]}
        size={18}
        color={statusColor(props.task.status)}
      />
      <View class="min-w-0 grow basis-0">
        <View class="flex-row gap-3">
          <Text class="min-w-0 grow basis-0 truncate text-base leading-[20px] text-foreground">
            {props.task.title}
          </Text>
          <Text class="text-sm leading-[20px] text-muted-foreground">
            {ago(props.task.updatedAt)}
          </Text>
        </View>
        <View class="flex-row items-center gap-3">
          <Text class="min-w-0 grow basis-0 truncate text-sm leading-4 text-muted-foreground">
            {meta()}
          </Text>
          <RunState task={props.task} />
          <If when={props.task.comments > 0}>
            <View class="flex-row items-center gap-1">
              <Icon name="chatCircle" size={13} color="muted-foreground" />
              <Text class="text-sm leading-4 text-muted-foreground">
                {props.task.comments}
              </Text>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

/** A row of a fold: the second line says it all, there is nothing going on to show. */
function PastRow(props: { task: BoardTaskView }) {
  const task = () => props.task;
  return (
    <View
      role="button"
      testID={`task-${task().number}`}
      accessibilityLabel={task().title}
      onPress={() => go.task(task().id)}
      class="h-14 shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
    >
      <Icon
        name={STATUS_ICONS[task().status]}
        size={18}
        color="muted-foreground"
      />
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-base leading-[20px] text-foreground">
          {task().title}
        </Text>
        <Text class="truncate text-sm leading-4 text-muted-foreground">
          {`#${task().number} · ${actorName(executor(task()))} · ${past(task().updatedAt)}`}
        </Text>
      </View>
    </View>
  );
}

function Fold(props: {
  status: BoardTaskStatus;
  tasks: BoardTaskView[];
  first: boolean;
}) {
  const open = signal(false);
  const all = signal(false);
  const shown = () => (all() ? props.tasks : props.tasks.slice(0, FOLD_ROWS));
  const hidden = () => props.tasks.length - shown().length;
  return (
    <>
      <View
        role="button"
        testID={`fold-${props.status}`}
        accessibilityLabel={statusLabel(props.status)}
        onPress={() => open.update((value) => !value)}
        class={`h-12 shrink-0 flex-row items-center gap-[10px] bg-surface px-4 active:bg-muted ${props.first ? "" : "border-t border-border"}`}
      >
        <Text class="grow basis-0 text-base leading-[18px] text-foreground">
          {statusLabel(props.status)}
        </Text>
        <Text class="text-sm leading-4 text-muted-foreground">
          {props.tasks.length}
        </Text>
        <Icon
          name={open() ? "caretDown" : "caretRight"}
          size={14}
          color="faint"
        />
      </View>
      <If when={open()}>
        <Each of={shown()} key={(task) => task.id}>
          {(task) => <PastRow task={task()} />}
        </Each>
        <If when={hidden() > 0}>
          <View
            role="button"
            onPress={() => all.set(true)}
            class="h-11 shrink-0 flex-row items-center border-t border-border pl-11 pr-4 active:bg-muted"
          >
            <Text class="text-md leading-4 text-muted-foreground">
              {t("tasks.more", { count: hidden() })}
            </Text>
          </View>
        </If>
      </If>
    </>
  );
}

/** 05c: which group's tasks to look at. A group with none says so, and comes last. */
function ScopeSheet(props: {
  open: boolean;
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  onClose: () => void;
}) {
  const groups = () => {
    const counted = conversations()
      .filter((group) => group.kind === "group" && !group.archived)
      .map((group) => ({
        id: group.id,
        name: group.name,
        count: boardTasks().filter((task) => task.conversationId === group.id)
          .length,
      }));
    return [
      ...counted.filter((g) => g.count > 0),
      ...counted.filter((g) => g.count === 0),
    ];
  };
  const pick = (id: string | undefined) => {
    props.onChange(id);
    props.onClose();
  };
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <View class="h-[52px] shrink-0 flex-row items-center px-4">
        <Text class="text-lead leading-[18px] text-foreground">
          {t("tasks.scope.title")}
        </Text>
      </View>
      <Scroll style={{ maxHeight: 480 }}>
        <View
          role="button"
          onPress={() => pick(undefined)}
          class="h-[52px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
        >
          <Text class="grow basis-0 text-lead leading-[18px] text-foreground">
            {t("tasks.scope.all")}
          </Text>
          <Text class="text-sm leading-4 text-muted-foreground">
            {boardTasks().length}
          </Text>
          <Icon
            name="check"
            size={16}
            color={props.value === undefined ? "foreground" : "faint"}
          />
        </View>
        <Each of={groups()} key={(group) => group.id}>
          {(group) => (
            <View
              role="button"
              testID={`scope-${group().id}`}
              onPress={() => pick(group().id)}
              class={`shrink-0 flex-row items-center gap-[10px] border-t border-border pl-4 active:bg-muted ${group().count === 0 ? "h-[60px]" : "h-[52px]"} ${props.value === group().id ? "pr-4" : "pr-[42px]"}`}
            >
              <View class="min-w-0 grow basis-0">
                <Text
                  class={`truncate text-lead ${group().count === 0 ? "leading-[22px] text-muted-foreground" : "leading-[18px] text-foreground"}`}
                >
                  {group().name}
                </Text>
                <If when={group().count === 0}>
                  <Text class="text-sm leading-4 text-muted-foreground">
                    {t("tasks.scope.emptyGroup")}
                  </Text>
                </If>
              </View>
              <If when={group().count > 0}>
                <Text class="text-sm leading-4 text-muted-foreground">
                  {group().count}
                </Text>
              </If>
              <If when={props.value === group().id}>
                <Icon name="check" size={16} />
              </If>
            </View>
          )}
        </Each>
      </Scroll>
    </Sheet>
  );
}

export function TasksTab() {
  // `tasks` comes with hello; subscribing keeps it current.
  useTarget("tasks");
  const scope = signal<string | undefined>(undefined);
  const picking = signal(false);
  const tasks = computed(() => {
    const id = scope();
    return id === undefined
      ? boardTasks()
      : boardTasks().filter((task) => task.conversationId === id);
  });
  const of = (status: BoardTaskStatus) =>
    tasks().filter((task) => task.status === status);
  const sections = () =>
    OPEN_STATUSES.filter((status) => of(status).length > 0);
  const folds = () => FOLDED_STATUSES.filter((status) => of(status).length > 0);
  const bar = () => BAR.filter((part) => of(part.status).length > 0);
  const scopeName = () => {
    const id = scope();
    return id === undefined
      ? t("tasks.scope.all")
      : (conversations().find((group) => group.id === id)?.name ??
          t("tasks.scope.all"));
  };
  return (
    <View class="flex-1">
      <View class="h-14 shrink-0 flex-row items-center justify-between gap-4 px-4">
        <Text class="grow basis-0 text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
          {t("tasks.title")}
          <If when={tasks().length > 0}>
            <Text class="text-muted-foreground"> {tasks().length}</Text>
          </If>
        </Text>
        <If when={boardTasks().length > 0}>
          <View
            role="button"
            testID="task-scope"
            onPress={() => picking.set(true)}
            class="h-11 flex-row items-center gap-1 active:opacity-60"
          >
            <Text class="text-md leading-4 text-foreground">{scopeName()}</Text>
            <Icon name="caretDown" size={12} color="muted-foreground" />
          </View>
        </If>
      </View>
      <If when={bar().length > 0}>
        <View class="h-1 shrink-0 flex-row gap-[2px] px-4">
          <Each of={bar()} key={(part) => part.status}>
            {(part) => (
              <View
                class={part().class}
                style={{ flexGrow: of(part().status).length, flexBasis: 0 }}
              />
            )}
          </Each>
        </View>
      </If>
      <If
        when={tasks().length > 0}
        else={
          <View class="grow basis-0 border-t border-border">
            <If
              when={boardTasks().length > 0}
              else={
                <Empty
                  title={t("tasks.empty.title")}
                  body={t("tasks.empty.description")}
                />
              }
            >
              <Empty title={t("tasks.scope.emptyGroup")} />
            </If>
          </View>
        }
      >
        <Scroll style={{ flex: 1 }}>
          <Each of={sections()} key={(status) => status}>
            {(status, index) => (
              <>
                <View
                  class={`shrink-0 flex-row items-end justify-between px-4 pb-[6px] ${index() === 0 ? "h-9" : "h-[42px] border-t border-border"}`}
                >
                  <Text class="text-sm leading-[18px] text-foreground">
                    {statusLabel(status())}
                  </Text>
                  <Text class="text-sm leading-[18px] text-muted-foreground">
                    {of(status()).length}
                  </Text>
                </View>
                <Each of={of(status())} key={(task) => task.id}>
                  {(task) => <TaskRow task={task()} />}
                </Each>
              </>
            )}
          </Each>
          <If when={folds().length > 0}>
            <View class="border-t border-border-strong bg-surface">
              <Each of={folds()} key={(status) => status}>
                {(status, index) => (
                  <Fold
                    status={status()}
                    tasks={of(status())}
                    first={index() === 0}
                  />
                )}
              </Each>
            </View>
          </If>
        </Scroll>
      </If>
      <ScopeSheet
        open={picking()}
        value={scope()}
        onChange={(id) => scope.set(id)}
        onClose={() => picking.set(false)}
      />
    </View>
  );
}
