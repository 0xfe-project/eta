import type {
  BoardTaskDetail,
  BoardTaskView,
  TaskResults,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { TextVariant } from "../../components";
import { Image, Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Modal,
  row,
} from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import {
  dependentsOf,
  isWaiting,
  planLevels,
  runningFor,
  taskDay,
  taskHint,
} from "./facts";
import { statusName, TaskGlyph } from "./status";

/** The sizes the plan is drawn at: on the Tasks page, and on a parent's own Plan tab, on desktop and tablet. */
const sizes = {
  page: {
    cardWidth: 256,
    cardHeight: 52,
    columnGap: 36,
    rowGap: 9,
    left: 13,
    labelTop: 16,
    cardsTop: 37,
    tileHeight: 30,
    legendGap: 12,
    bottom: 16,
    padding: 9,
    titleVariant: "small" as TextVariant,
    criticalBorder: 1,
    indent: 0,
  },
  detail: {
    cardWidth: 254,
    cardHeight: 49,
    columnGap: 38,
    rowGap: 11,
    left: 12,
    labelTop: 15,
    cardsTop: 36,
    tileHeight: 33,
    legendGap: 16,
    bottom: 15,
    padding: 10,
    titleVariant: "caption" as TextVariant,
    criticalBorder: 2,
    indent: 18,
  },
  tabletPage: tabletSize(180),
  tabletDetail: tabletSize(170),
};

/** Taller cards whose title and line wrap, in a 12px frame; the legend sits outside it. */
function tabletSize(cardWidth: number) {
  return {
    cardWidth,
    cardHeight: 64,
    columnGap: 36,
    rowGap: 12,
    left: 12,
    labelTop: 12,
    cardsTop: 40,
    tileHeight: 28,
    legendGap: 0,
    bottom: 12,
    padding: 8,
    titleVariant: "small" as TextVariant,
    criticalBorder: 1,
    indent: 18,
  };
}

const isTablet = (variant: keyof typeof sizes) =>
  variant === "tabletPage" || variant === "tabletDetail";

function planGraph(all: BoardTaskView[]) {
  const tasks = all
    .filter((task) => task.status !== "cancelled")
    .sort((a, b) => a.number - b.number);
  const { levels, parents } = planLevels(tasks);
  const columns: BoardTaskView[][] = [];
  for (const task of tasks)
    (columns[levels.get(task.id) ?? 0] ??= []).push(task);
  const critical = new Set<string>();
  let last = columns.at(-1)?.[0]?.id;
  while (last && !critical.has(last)) {
    critical.add(last);
    last = parents.get(last);
  }
  return { columns, critical, parents };
}

/** How many of a plan's steps still have something not done. */
function stepsToGo(tasks: BoardTaskView[]) {
  return planGraph(tasks).columns.filter((column) =>
    column.some(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ),
  ).length;
}

/** Tasks laid out by step, one column per step, with the waits between them drawn as curves. */
function PlanGraph(props: {
  tasks: BoardTaskView[];
  variant: keyof typeof sizes;
  desktop: boolean;
  onOpen: (id: string) => void;
  onConnect: (from: string, to: string) => void;
  onConnectFrom: (id: string) => void;
  onAddStep?: () => void;
}) {
  const c = colors();
  const host = useHost();
  const size = () => sizes[props.variant];
  const graph = () => planGraph(props.tasks);
  const drag = taskDropZones<string>((from, to) => {
    if (from !== to && props.tasks.some((task) => task.id === to))
      props.onConnect(from, to);
  });
  const pitch = () => size().cardHeight + size().rowGap;
  const x = (column: number) =>
    size().left + column * (size().cardWidth + size().columnGap);
  const y = (index: number) => size().cardsTop + index * pitch();
  const height = () => {
    const columns = graph().columns;
    const rows = Math.max(
      1,
      ...columns.map((column) => column.length * pitch() - size().rowGap),
    );
    const tile = props.onAddStep
      ? (columns.at(-1)?.length ?? 0) * pitch() + size().tileHeight
      : 0;
    return size().cardsTop + Math.max(rows, tile);
  };
  const width = () =>
    x(Math.max(1, graph().columns.length)) - size().columnGap + size().left;
  const edges = () => {
    const place = new Map<string, { x: number; y: number }>();
    graph().columns.forEach((column, index) =>
      column.forEach((task, rowIndex) =>
        place.set(task.id, {
          x: x(index),
          y: y(rowIndex) + size().cardHeight / 2,
        }),
      ),
    );
    return graph()
      .columns.flat()
      .flatMap((task) =>
        (task.dependsOn ?? []).flatMap((edge) => {
          const from = place.get(edge.taskId);
          const to = place.get(task.id);
          if (!from || !to || to.x <= from.x) return [];
          const start = from.x + size().cardWidth;
          const middle = (start + to.x) / 2;
          const critical =
            graph().critical.has(task.id) && graph().critical.has(edge.taskId);
          return [
            `<path d="M${start} ${from.y}C${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}" fill="none" stroke="${critical ? c().ink : c().strong}" stroke-width="1.5"/>`,
          ];
        }),
      );
  };
  const stepLabel = (column: BoardTaskView[], index: number) => {
    const done = column.filter((task) => task.status === "done").length;
    if (done === column.length)
      return uiText("doneWithCount", { length: done, value2: column.length });
    if (column.length > 1) return uiText("sideBySide");
    if (index > 1) return uiText("afterStep", { step: index });
    return "";
  };
  return (
    <View>
      <View style={{ position: "relative", height: height(), width: width() }}>
        <Image
          src={`data:image/svg+xml,${encodeURIComponent(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width()}" height="${height()}" viewBox="0 0 ${width()} ${height()}">${edges().join("")}</svg>`,
          )}`}
          fadeDuration={0}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: width(),
            height: height(),
          }}
        />
        <Each of={graph().columns} key="index">
          {(column, index) => (
            <View
              style={{
                ...row,
                position: "absolute",
                top: size().labelTop,
                left: x(index()),
                width: size().cardWidth,
                justifyContent: "space-between",
              }}
            >
              <Label variant="caption" weight={600}>
                {uiText("step", { value1: index() + 1 })}
              </Label>
              <Label variant="caption" tone="muted">
                {stepLabel(column(), index())}
              </Label>
            </View>
          )}
        </Each>
        <Each of={graph().columns} key="index">
          {(column, index) => (
            <Each of={column()} key={(task) => task.id}>
              {(task, rowIndex) => (
                <PlanCard
                  task={task()}
                  variant={props.variant}
                  critical={graph().critical.has(task().id)}
                  dependents={dependentsOf(task(), host.tasks()).length}
                  desktop={props.desktop}
                  drag={drag}
                  left={x(index())}
                  top={y(rowIndex())}
                  onOpen={() => props.onOpen(task().id)}
                  onConnectFrom={() => props.onConnectFrom(task().id)}
                />
              )}
            </Each>
          )}
        </Each>
        <If when={props.onAddStep}>
          {(add) => (
            <View
              role="button"
              accessibilityLabel={uiText("addAStepAtTheEnd")}
              onPress={() => add()()}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                position: "absolute",
                left: x(Math.max(0, graph().columns.length - 1)),
                top: y(graph().columns.at(-1)?.length ?? 0),
                width: size().cardWidth,
                height: size().tileHeight,
                paddingHorizontal: isTablet(props.variant) ? 8 : 10,
                gap: 6,
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: c().strong,
                cursor: "pointer",
              }}
            >
              <Icon
                name="plus"
                size={isTablet(props.variant) ? 11 : 10}
                tone="mutedInk"
              />
              <Label variant="caption" tone="mutedInk">
                {uiText("addAStepAtTheEnd")}
              </Label>
            </View>
          )}
        </If>
      </View>
      <If
        when={!isTablet(props.variant)}
        else={<View style={{ height: size().bottom }} />}
      >
        <View
          style={{
            ...row,
            gap: 18,
            paddingLeft: size().left - 1,
            marginTop: size().legendGap,
            marginBottom: size().bottom,
          }}
        >
          <PlanLegend />
          <If when={props.desktop}>
            <Label variant="caption" tone="muted">
              {uiText("dragToMakeWait")}
            </Label>
          </If>
        </View>
      </If>
    </View>
  );
}

/** What each mark in the plan means. */
function PlanLegend() {
  const c = colors();
  return (
    <>
      <View style={{ ...row, gap: 5 }}>
        <TaskGlyph status="done" size={11} />
        <Label variant="caption" tone="muted">
          {uiText("taskDone")}
        </Label>
      </View>
      <View style={{ ...row, gap: 5 }}>
        <TaskGlyph status="in_review" size={12} />
        <Label variant="caption" tone="muted">
          {uiText("inReviewLetsNextGo")}
        </Label>
      </View>
      <View style={{ ...row, gap: 5 }}>
        <TaskGlyph status="in_progress" size={11} />
        <Label variant="caption" tone="muted">
          {statusName("in_progress")}
        </Label>
      </View>
      <View style={{ ...row, gap: 5 }}>
        <Icon name="lock" size={11} tone="muted" />
        <Label variant="caption" tone="muted">
          {uiText("taskWaitingForOthers")}
        </Label>
      </View>
      <View style={{ ...row, gap: 5 }}>
        <View
          style={{
            width: 14,
            height: 2,
            backgroundColor: c().ink,
          }}
        />
        <Label variant="caption" tone="muted">
          {uiText("criticalPath")}
        </Label>
      </View>
    </>
  );
}

function PlanCard(props: {
  task: BoardTaskView;
  variant: keyof typeof sizes;
  critical: boolean;
  dependents: number;
  desktop: boolean;
  drag: ReturnType<typeof taskDropZones<string>>;
  left: number;
  top: number;
  onOpen: () => void;
  onConnectFrom: () => void;
}) {
  const c = colors();
  const host = useHost();
  const size = () => sizes[props.variant];
  const gesture = props.drag.gesture(props.task.id);
  const hint = () => {
    const task = props.task;
    if (task.status === "done")
      return `${uiText("taskDone")} · ${taskDay(task.updatedAt)}`;
    if (task.status === "in_progress") return `■ ${runningFor(task)}`;
    return taskHint(task, host.tasks()) ?? statusName(task.status);
  };
  const tone = () =>
    props.task.status === "in_review"
      ? "amber"
      : props.task.status === "in_progress"
        ? "blue"
        : "muted";
  return (
    <View
      role="button"
      accessibilityLabel={props.task.title}
      ref={(view) => props.drag.register(props.task.id, view)}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        position: "absolute",
        left: props.left,
        top: props.top,
        width: size().cardWidth,
        height: size().cardHeight,
        paddingVertical: isTablet(props.variant) ? 7 : 6,
        paddingHorizontal: size().padding,
        gap: isTablet(props.variant) ? 3 : 6,
        borderWidth: props.critical ? size().criticalBorder : 1,
        borderColor: props.critical ? c().ink : c().strong,
        backgroundColor: c().canvas,
        opacity: props.drag.active() === props.task.id ? 0.65 : 1,
        cursor: "pointer",
      }}
    >
      <View style={{ ...row, gap: 6 }}>
        <TaskGlyph
          status={props.task.status}
          size={isTablet(props.variant) ? 12 : 11}
        />
        <Label
          variant={size().titleVariant}
          weight={size().titleVariant === "caption" ? 600 : 400}
          lines={isTablet(props.variant) ? 2 : 1}
          style={{ flex: 1, minWidth: 0 }}
        >
          {props.task.title}
        </Label>
      </View>
      <View style={{ ...row, gap: 4, paddingLeft: size().indent }}>
        <Label variant="caption" tone="muted">
          {`#${props.task.number} ·`}
        </Label>
        <If when={isWaiting(props.task)}>
          <Icon name="lock" size={10} tone="muted" />
        </If>
        <Label
          variant="caption"
          tone={tone()}
          lines={isTablet(props.variant) ? 2 : 1}
          style={{ flex: 1, minWidth: 0 }}
        >
          {hint()}
        </Label>
      </View>
      <If when={props.desktop}>
        <View
          role="button"
          accessibilityLabel={uiText("taskConnectFrom", {
            number: props.task.number,
          })}
          onPressDown={gesture.onPressDown}
          onPanStart={gesture.onPanStart}
          onPanEnd={gesture.onPanEnd}
          onPress={props.onConnectFrom}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 10,
            cursor: "crosshair",
          }}
        />
      </If>
    </View>
  );
}

/** Adding to a plan: a step at its end, a subtask, or a wait between two of its tasks. */
function createPlanEditing(owner: () => string | undefined) {
  const host = useHost();
  const saving = signal(false);
  const adding = signal<
    { parent: string; dependsOn: string[]; title: string } | undefined
  >(undefined);
  const stepTitle = signal("");
  const connecting = signal<{ tasks: BoardTaskView[] } | undefined>(undefined);
  const prerequisite = signal("");
  const dependent = signal("");
  async function create() {
    const target = adding();
    const assignee = owner();
    if (!target || !assignee || !stepTitle().trim() || saving()) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call<TaskResults["create"]>("tasks", "create", {
        parent: target.parent,
        tasks: [
          {
            title: stepTitle().trim(),
            assignee,
            dependsOn: target.dependsOn.map((task) => ({ task })),
          },
        ],
      }),
    );
    saving.set(false);
    if (result) adding.set(undefined);
  }
  async function connect(from: string, to: string) {
    if (saving() || !from || !to || from === to) return;
    saving.set(true);
    const result = await host.action(() =>
      host.call("tasks", "addDependency", { taskId: to, dependsOn: from }),
    );
    saving.set(false);
    if (result) connecting.set(undefined);
  }
  function startAdding(parent: string, dependsOn: string[], title: string) {
    stepTitle.set("");
    adding.set({ parent, dependsOn, title });
  }
  function startConnecting(tasks: BoardTaskView[], from: string) {
    prerequisite.set(from);
    dependent.set("");
    connecting.set({ tasks });
  }
  function Dialogs() {
    return (
      <>
        <If when={adding()}>
          {(target) => (
            <Modal
              title={target().title}
              width={440}
              overPhoneNavigation
              onClose={() => adding.set(undefined)}
            >
              <View style={{ padding: 16, gap: 8 }}>
                <If when={target().dependsOn.length}>
                  <Label variant="small" tone="muted">
                    {uiText("thisTaskWaitsForTheTasks")}
                  </Label>
                </If>
                <Field
                  label={uiText("taskTitle")}
                  value={stepTitle()}
                  onChange={stepTitle.set}
                  onSubmit={() => void create()}
                />
                <Button
                  label={uiText("addTask")}
                  tone="primary"
                  disabled={!stepTitle().trim() || saving()}
                  onPress={() => void create()}
                />
              </View>
            </Modal>
          )}
        </If>
        <If when={connecting()}>
          {(target) => (
            <Modal
              title={uiText("addDependency")}
              width={440}
              onClose={() => connecting.set(undefined)}
            >
              <View style={{ padding: 16, gap: 8 }}>
                <Label>{uiText("chooseTheTaskThatWaitsAnd")}</Label>
                <ActionMenu
                  label={uiText("taskThatWaits")}
                  value={
                    target().tasks.find((task) => task.id === dependent())
                      ?.title ?? "Select task"
                  }
                >
                  <Each of={target().tasks} key={(task) => task.id}>
                    {(task) => (
                      <ActionItem
                        label={task().title}
                        checked={dependent() === task().id}
                        onSelect={() => {
                          if (prerequisite() === task().id)
                            prerequisite.set("");
                          dependent.set(task().id);
                        }}
                      />
                    )}
                  </Each>
                </ActionMenu>
                <ActionMenu
                  label={uiText("prerequisite")}
                  value={
                    target().tasks.find((task) => task.id === prerequisite())
                      ?.title ?? "Select prerequisite"
                  }
                >
                  <Each
                    of={target().tasks.filter(
                      (task) =>
                        task.id !== dependent() && task.status !== "cancelled",
                    )}
                    key={(task) => task.id}
                  >
                    {(task) => (
                      <ActionItem
                        label={task().title}
                        checked={prerequisite() === task().id}
                        onSelect={() => prerequisite.set(task().id)}
                      />
                    )}
                  </Each>
                </ActionMenu>
                <Button
                  label={uiText("addDependency")}
                  tone="primary"
                  disabled={saving() || !prerequisite() || !dependent()}
                  onPress={() => void connect(prerequisite(), dependent())}
                />
              </View>
            </Modal>
          )}
        </If>
      </>
    );
  }
  return { startAdding, startConnecting, connect, Dialogs };
}

/** The steps still to go, for a parent's plan. */
function stepsCaption(number: number, tasks: BoardTaskView[]) {
  const left = stepsToGo(tasks);
  return left
    ? uiText("stepsToGo", { number, count: left })
    : uiText("stepsAllDone", { number });
}

/** A parent's own Plan tab. */
export function TaskPlan(props: {
  task: () => BoardTaskDetail;
  onOpen: (id: string) => void;
  desktop: boolean;
  tablet?: boolean;
}) {
  const c = colors();
  const host = useHost();
  const owner = () =>
    props.task().assigneeAgentId ??
    props.task().createdBy.agentId ??
    host.people()[0]?.id;
  const editing = createPlanEditing(owner);
  const children = () => {
    const known = new Map(
      [...host.list<BoardTaskView>("tasks", "archived"), ...host.tasks()].map(
        (task) => [task.id, task],
      ),
    );
    const ids = new Set([
      ...(props.task().children ?? []).map((child) => child.taskId),
      ...host
        .tasks()
        .filter((task) => task.parentId === props.task().id)
        .map((task) => task.id),
    ]);
    return [...ids].flatMap((id) => {
      const task = known.get(id);
      return task ? [task] : [];
    });
  };
  const lastStep = () =>
    planGraph(children())
      .columns.at(-1)
      ?.filter((task) => task.status !== "cancelled")
      .map((task) => task.id) ?? [];
  return (
    <Scroll style={grow}>
      <View
        style={
          props.tablet
            ? { paddingHorizontal: 20, paddingVertical: 14, gap: 12 }
            : { paddingHorizontal: 22, paddingTop: 16, gap: 14 }
        }
      >
        <Label variant="caption" tone="muted">
          {stepsCaption(props.task().number, children())}
        </Label>
        <Scroll horizontal>
          <View
            style={{
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().canvas,
              minWidth: "100%",
            }}
          >
            <PlanGraph
              tasks={children()}
              variant={props.tablet ? "tabletDetail" : "detail"}
              desktop={props.desktop}
              onOpen={props.onOpen}
              onConnect={(from, to) => void editing.connect(from, to)}
              onConnectFrom={(id) => editing.startConnecting(children(), id)}
              onAddStep={
                owner()
                  ? () =>
                      editing.startAdding(
                        props.task().id,
                        lastStep(),
                        uiText("addAStepAtTheEnd"),
                      )
                  : undefined
              }
            />
          </View>
        </Scroll>
        <If when={props.tablet}>
          <View style={{ ...row, gap: 18 }}>
            <PlanLegend />
          </View>
          <Label variant="caption" tone="muted">
            {uiText("dragToMakeWait")}
          </Label>
        </If>
      </View>
      <editing.Dialogs />
    </Scroll>
  );
}

/** The Tasks page's Plan view: one frame per parent, and one for the tasks that are part of nothing. */
export function TaskPlanBoard(props: {
  items: BoardTaskView[];
  tablet?: boolean;
  onOpen: (id: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const editing = createPlanEditing(() => host.people()[0]?.id);
  const ids = () => new Set(props.items.map((task) => task.id));
  const parents = () =>
    props.items.filter(
      (task) =>
        task.subtasks?.total ||
        props.items.some((other) => other.parentId === task.id),
    );
  const childrenOf = (parent: BoardTaskView) =>
    props.items.filter((task) => task.parentId === parent.id);
  const orphans = () =>
    props.items.filter(
      (task) =>
        !(task.parentId && ids().has(task.parentId)) &&
        !parents().some((parent) => parent.id === task.id),
    );
  return (
    <View
      style={
        props.tablet
          ? { paddingHorizontal: 14, paddingVertical: 12, gap: 12 }
          : { paddingHorizontal: 22, paddingVertical: 14, gap: 15 }
      }
    >
      <Each of={parents()} key={(task) => task.id}>
        {(parent) => (
          <PlanFrame>
            <View
              style={{
                ...row,
                height: props.tablet ? 36 : 37,
                paddingHorizontal: props.tablet ? 12 : 13,
                gap: 8,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <TaskGlyph status={parent().status} size={12} />
              <View
                role="button"
                accessibilityLabel={parent().title}
                onPress={() => props.onOpen(parent().id)}
                style={{ cursor: "pointer" }}
              >
                <Label weight={600}>{parent().title}</Label>
              </View>
              <Label variant="caption" tone="muted" style={{ flex: 1 }}>
                {stepsCaption(parent().number, childrenOf(parent()))}
              </Label>
              <View
                role="button"
                accessibilityLabel={uiText("addSubtask")}
                onPress={() =>
                  editing.startAdding(parent().id, [], uiText("addSubtask"))
                }
                hoverStyle={{ backgroundColor: c().selected }}
                style={{ ...row, gap: 4, height: 24, cursor: "pointer" }}
              >
                <Icon name="plus" size={props.tablet ? 11 : 10} />
                <Label variant="caption">{uiText("subtask")}</Label>
              </View>
            </View>
            <PlanGraph
              tasks={childrenOf(parent())}
              variant={props.tablet ? "tabletPage" : "page"}
              desktop
              onOpen={props.onOpen}
              onConnect={(from, to) => void editing.connect(from, to)}
              onConnectFrom={(id) =>
                editing.startConnecting(childrenOf(parent()), id)
              }
              onAddStep={() =>
                editing.startAdding(
                  parent().id,
                  planGraph(childrenOf(parent()))
                    .columns.at(-1)
                    ?.filter((task) => task.status !== "cancelled")
                    .map((task) => task.id) ?? [],
                  uiText("addAStepAtTheEnd"),
                )
              }
            />
          </PlanFrame>
        )}
      </Each>
      <If when={orphans().length}>
        <PlanFrame>
          <View
            style={{
              ...row,
              height: props.tablet ? 36 : 37,
              paddingHorizontal: props.tablet ? 12 : 13,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="caption" tone="mutedInk">
              {uiText("notPartOfAnything")}
            </Label>
          </View>
          <PlanGraph
            tasks={orphans()}
            variant={props.tablet ? "tabletPage" : "page"}
            desktop
            onOpen={props.onOpen}
            onConnect={(from, to) => void editing.connect(from, to)}
            onConnectFrom={(id) => editing.startConnecting(orphans(), id)}
          />
        </PlanFrame>
      </If>
      <If when={props.tablet}>
        <Label variant="caption" tone="muted">
          {uiText("dragToMakeWait")}
        </Label>
      </If>
      <editing.Dialogs />
    </View>
  );
}

function PlanFrame(props: { children: JSX.Element }) {
  const c = colors();
  return (
    <Scroll horizontal>
      <View
        style={{
          minWidth: "100%",
          borderWidth: 1,
          borderColor: c().border,
          backgroundColor: c().canvas,
        }}
      >
        {props.children}
      </View>
    </Scroll>
  );
}
