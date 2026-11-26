import type {
  BoardTaskDetail,
  BoardTaskView,
  TaskResults,
} from "@eta/client-contracts";
import type { Accessor, JSX } from "nsh";
import type { TextVariant } from "../../components";
import type { StandalonePlanChain } from "./facts";
import { computed, Image, Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  focusRing,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { foldNext } from "../../components/motion";
import { control, icon, opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { taskDropZones } from "./drag";
import {
  dependentsOf,
  isWaiting,
  planLevels,
  runningFor,
  standaloneDependencyChains,
  taskDay,
  taskHint,
} from "./facts";
import { statusName, TaskGlyph } from "./status";

/** A dependency line's sample in the legend; the strip at a card's right edge that starts one;
 * a parent's header row over its subtasks. */
const legendLineWidth = 16;
const handleWidth = 12;
const frameHeaderHeight = 36;

/** The sizes the plan is drawn at: on the Tasks page, and on a parent's own Plan tab, on desktop and tablet. */
const sizes = {
  page: {
    cardWidth: 256,
    cardHeight: 52,
    columnGap: space[32],
    rowGap: space[8],
    left: 12,
    labelTop: 16,
    cardsTop: 36,
    tileHeight: 32,
    legendGap: 12,
    bottom: 16,
    padding: space[8],
    titleVariant: "small" as TextVariant,
    criticalBorder: 1,
    indent: 0,
  },
  detail: {
    cardWidth: 256,
    cardHeight: 48,
    columnGap: space[32],
    rowGap: space[12],
    left: 12,
    labelTop: 16,
    cardsTop: 36,
    tileHeight: 32,
    legendGap: 16,
    bottom: 16,
    padding: space[12],
    titleVariant: "caption" as TextVariant,
    criticalBorder: 2,
    // The title after its glyph.
    indent: icon.sm + space[4],
  },
  tabletPage: tabletSize(180),
  tabletDetail: tabletSize(168),
};

/** Taller cards whose title and line wrap, in a 12px frame; the legend sits outside it. */
function tabletSize(cardWidth: number) {
  return {
    cardWidth,
    cardHeight: 64,
    columnGap: space[32],
    rowGap: space[12],
    left: 12,
    labelTop: 12,
    cardsTop: 40,
    tileHeight: 28,
    legendGap: 0,
    bottom: 12,
    padding: space[8],
    titleVariant: "small" as TextVariant,
    criticalBorder: 1,
    // The title after its glyph.
    indent: icon.sm + space[4],
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
  // What the drawing depends on: which task is in which step, how far each is, and what it waits for.
  const shape = columns
    .map((column) =>
      column
        .map(
          (task) =>
            `${task.id}:${task.status}:${(task.dependsOn ?? []).map((edge) => edge.taskId).join(",")}`,
        )
        .join(" "),
    )
    .join("|");
  return { columns, critical, parents, shape };
}

type Plan = ReturnType<typeof planGraph>;

/**
 * A plan's graph, built again when its tasks are, but only passed on when its shape changed: the
 * host sends every task anew whenever any of them moves (a running task's tokens, every few
 * seconds), and that must not lay the whole plan out again. Its tasks are the ones of when the
 * shape last changed; what a card shows is read from the tasks of now.
 */
function createPlan(tasks: () => BoardTaskView[]): Accessor<Plan> {
  return computed(() => planGraph(tasks()), {
    equals: (previous, next) => previous.shape === next.shape,
  });
}

/** The tasks of the plan that are not cancelled in its last step, for a step added after it. */
function lastStep(plan: Plan) {
  return (
    plan.columns
      .at(-1)
      ?.filter((task) => task.status !== "cancelled")
      .map((task) => task.id) ?? []
  );
}

/** How many of a plan's steps still have something not done. */
function stepsToGo(plan: Plan) {
  return plan.columns.filter((column) =>
    column.some(
      (task) => task.status !== "done" && task.status !== "cancelled",
    ),
  ).length;
}

/** Tasks laid out by step, one column per step, with the waits between them drawn as curves. */
function PlanGraph(props: {
  tasks: BoardTaskView[];
  plan: Plan;
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
  const graph = () => props.plan;
  const current = computed(
    () => new Map(props.tasks.map((task) => [task.id, task])),
  );
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
              <Label variant="caption" weight={weight.strong}>
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
                  task={current().get(task().id) ?? task()}
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
                paddingHorizontal: isTablet(props.variant)
                  ? space[8]
                  : space[12],
                gap: space[4],
                borderWidth: 1,
                borderStyle: "dashed",
                borderColor: c().strong,
                cursor: "pointer",
              }}
            >
              <Icon
                name="plus"
                size={isTablet(props.variant) ? icon.sm : icon.sm}
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
            gap: space[16],
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
      <View style={{ ...row, gap: space[4] }}>
        <TaskGlyph status="done" size={icon.sm} />
        <Label variant="caption" tone="muted">
          {uiText("taskDone")}
        </Label>
      </View>
      <View style={{ ...row, gap: space[4] }}>
        <TaskGlyph status="in_review" size={icon.sm} />
        <Label variant="caption" tone="muted">
          {uiText("inReviewLetsNextGo")}
        </Label>
      </View>
      <View style={{ ...row, gap: space[4] }}>
        <TaskGlyph status="in_progress" size={icon.sm} />
        <Label variant="caption" tone="muted">
          {statusName("in_progress")}
        </Label>
      </View>
      <View style={{ ...row, gap: space[4] }}>
        <Icon name="lock" size={icon.sm} tone="muted" />
        <Label variant="caption" tone="muted">
          {uiText("taskWaitingForOthers")}
        </Label>
      </View>
      <View style={{ ...row, gap: space[4] }}>
        <View
          style={{
            width: legendLineWidth,
            height: space[2],
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
      ? "warning"
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
        paddingVertical: isTablet(props.variant) ? space[8] : space[8],
        paddingHorizontal: size().padding,
        gap: isTablet(props.variant) ? space[2] : space[4],
        borderWidth: props.critical ? size().criticalBorder : 1,
        borderColor: props.critical ? c().ink : c().strong,
        backgroundColor: c().canvas,
        opacity: props.drag.active() === props.task.id ? opacity.muted : 1,
        cursor: "pointer",
      }}
    >
      <View style={{ ...row, gap: space[4] }}>
        <TaskGlyph
          status={props.task.status}
          size={isTablet(props.variant) ? icon.sm : icon.sm}
        />
        <Label
          variant={size().titleVariant}
          weight={
            size().titleVariant === "caption" ? weight.strong : weight.regular
          }
          lines={isTablet(props.variant) ? 2 : 1}
          style={{ flex: 1, minWidth: 0 }}
        >
          {props.task.title}
        </Label>
      </View>
      <View style={{ ...row, gap: space[4], paddingLeft: size().indent }}>
        <Label variant="caption" tone="muted">
          {`#${props.task.number} ·`}
        </Label>
        <If when={isWaiting(props.task)}>
          <Icon name="lock" size={icon.sm} tone="muted" />
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
            width: handleWidth,
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
              width={dialogWidth.md}
              overPhoneNavigation
              onClose={() => adding.set(undefined)}
            >
              <View style={{ padding: space[16], gap: space[8] }}>
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
                  disabled={!stepTitle().trim()}
                  busy={saving()}
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
              width={dialogWidth.md}
              onClose={() => connecting.set(undefined)}
            >
              <View style={{ padding: space[16], gap: space[8] }}>
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
                  disabled={!prerequisite() || !dependent()}
                  busy={saving()}
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
function stepsCaption(number: number, plan: Plan) {
  const left = stepsToGo(plan);
  return left
    ? uiText("stepsToGo", { number, count: left })
    : uiText("stepsAllDone", { number });
}

/** The steps still to go, for a standalone dependency chain. */
function chainCaption(number: number, tasks: number, plan: Plan) {
  const left = stepsToGo(plan);
  if (!left) return uiText("chainAllDone", { number, tasks });
  return uiText(left === 1 ? "chainStepToGo" : "chainStepsToGo", {
    number,
    tasks,
    steps: left,
  });
}

function ChainPlanFrame(props: {
  chain: Accessor<StandalonePlanChain>;
  tablet?: boolean;
  onOpen: (id: string) => void;
  onConnect: (from: string, to: string) => void;
  onConnectFrom: (tasks: BoardTaskView[], id: string) => void;
}) {
  const c = colors();
  const plan = createPlan(() => props.chain().tasks);
  return (
    <PlanFrame>
      <View
        style={{
          ...row,
          height: frameHeaderHeight,
          paddingHorizontal: space[12],
          gap: space[8],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <TaskGlyph status={props.chain().terminal.status} size={icon.sm} />
        <View
          role="button"
          accessibilityLabel={uiText("taskCardOpenTask", {
            number: props.chain().terminal.number,
          })}
          onPress={() => props.onOpen(props.chain().terminal.id)}
          style={{ cursor: "pointer" }}
        >
          <Label weight={weight.strong}>{props.chain().terminal.title}</Label>
        </View>
        <Label variant="caption" tone="muted" style={{ flex: 1 }}>
          {chainCaption(
            props.chain().terminal.number,
            props.chain().tasks.length,
            plan(),
          )}
        </Label>
      </View>
      <PlanGraph
        tasks={props.chain().tasks}
        plan={plan()}
        variant={props.tablet ? "tabletPage" : "page"}
        desktop
        onOpen={props.onOpen}
        onConnect={props.onConnect}
        onConnectFrom={(id) => props.onConnectFrom(props.chain().tasks, id)}
      />
    </PlanFrame>
  );
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
  const children = computed(() => {
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
  });
  const plan = createPlan(children);
  return (
    <SmoothScroll style={grow}>
      <View
        style={
          props.tablet
            ? {
                paddingHorizontal: space[20],
                paddingVertical: space[16],
                gap: space[12],
              }
            : {
                paddingHorizontal: space[24],
                paddingTop: space[16],
                gap: space[12],
              }
        }
      >
        <Label variant="caption" tone="muted">
          {stepsCaption(props.task().number, plan())}
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
              plan={plan()}
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
                        lastStep(plan()),
                        uiText("addAStepAtTheEnd"),
                      )
                  : undefined
              }
            />
          </View>
        </Scroll>
        <If when={props.tablet}>
          <View style={{ ...row, gap: space[16] }}>
            <PlanLegend />
          </View>
          <Label variant="caption" tone="muted">
            {uiText("dragToMakeWait")}
          </Label>
        </If>
      </View>
      <editing.Dialogs />
    </SmoothScroll>
  );
}

/** The Tasks page's Plan view: parent frames, top-level dependency-chain frames, and an empty state when none exist. */
export function TaskPlanBoard(props: {
  items: BoardTaskView[];
  tablet?: boolean;
  onOpen: (id: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const editing = createPlanEditing(() => host.people()[0]?.id);
  /** The parents among the tasks, each with its children among them, and standalone chains; in one pass. */
  const groups = computed(() => {
    const items = props.items;
    const children = new Map<string, BoardTaskView[]>();
    for (const task of items) {
      if (!task.parentId) continue;
      const siblings = children.get(task.parentId);
      if (siblings) siblings.push(task);
      else children.set(task.parentId, [task]);
    }
    const parents = items.filter(
      (task) => task.subtasks?.total || children.has(task.id),
    );
    const parentIds = new Set(parents.map((task) => task.id));
    const { active: activeChains, completed: completedChains } =
      standaloneDependencyChains(items, parentIds);
    return { children, parents, activeChains, completedChains };
  });
  const childrenOf = (parent: BoardTaskView) =>
    groups().children.get(parent.id) ?? [];
  const completedOverride = signal<boolean | undefined>(undefined);
  const hasActive = () =>
    groups().parents.length > 0 || groups().activeChains.length > 0;
  const completedExpanded = () => completedOverride() ?? !hasActive();
  const hasPlans = () => hasActive() || groups().completedChains.length > 0;
  const completedLabel = () =>
    uiText("completedPlans", { count: groups().completedChains.length });
  return (
    <If
      when={hasPlans()}
      else={
        <EmptyState
          size="page"
          status="empty"
          loading={null}
          error={null}
          empty={{
            art: "tasks",
            title: uiText("noPlansYet"),
            description: uiText("noPlansYetDescription"),
          }}
        />
      }
    >
      <View
        style={
          props.tablet
            ? {
                paddingHorizontal: space[16],
                paddingVertical: space[12],
                gap: space[12],
              }
            : {
                paddingHorizontal: space[24],
                paddingVertical: space[16],
                gap: space[16],
              }
        }
      >
        <Each of={groups().parents} key={(task) => task.id}>
          {(parent) => {
            const plan = createPlan(() => childrenOf(parent()));
            return (
              <PlanFrame>
                <View
                  style={{
                    ...row,
                    height: frameHeaderHeight,
                    paddingHorizontal: space[12],
                    gap: space[8],
                    borderBottomWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <TaskGlyph status={parent().status} size={icon.sm} />
                  <View
                    role="button"
                    accessibilityLabel={parent().title}
                    onPress={() => props.onOpen(parent().id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Label weight={weight.strong}>{parent().title}</Label>
                  </View>
                  <Label variant="caption" tone="muted" style={{ flex: 1 }}>
                    {stepsCaption(parent().number, plan())}
                  </Label>
                  <View
                    role="button"
                    accessibilityLabel={uiText("addSubtask")}
                    onPress={() =>
                      editing.startAdding(parent().id, [], uiText("addSubtask"))
                    }
                    hoverStyle={{ backgroundColor: c().selected }}
                    style={{
                      ...row,
                      gap: space[4],
                      height: space[24],
                      cursor: "pointer",
                    }}
                  >
                    <Icon name="plus" size={icon.sm} />
                    <Label variant="caption">{uiText("subtask")}</Label>
                  </View>
                </View>
                <PlanGraph
                  tasks={childrenOf(parent())}
                  plan={plan()}
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
                      lastStep(plan()),
                      uiText("addAStepAtTheEnd"),
                    )
                  }
                />
              </PlanFrame>
            );
          }}
        </Each>
        <Each of={groups().activeChains} key={(chain) => chain.key}>
          {(chain) => (
            <ChainPlanFrame
              chain={chain}
              tablet={props.tablet}
              onOpen={props.onOpen}
              onConnect={(from, to) => void editing.connect(from, to)}
              onConnectFrom={(tasks, id) => editing.startConnecting(tasks, id)}
            />
          )}
        </Each>
        <If when={groups().completedChains.length > 0}>
          <View style={{ gap: props.tablet ? space[12] : space[16] }}>
            <View
              role="button"
              accessibilityLabel={completedLabel()}
              accessibilityState={{ expanded: completedExpanded() }}
              onPress={() => {
                foldNext();
                completedOverride.set(!completedExpanded());
              }}
              hoverStyle={{ backgroundColor: c().selected }}
              focusVisibleStyle={focusRing(c())}
              style={{
                ...row,
                height: control.lg,
                paddingHorizontal: space[12],
                gap: space[8],
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().surface,
                cursor: "pointer",
              }}
            >
              <Icon
                name={completedExpanded() ? "down" : "right"}
                size={icon.sm}
                tone="muted"
              />
              <TaskGlyph status="done" size={icon.sm} />
              <Label variant="small" tone="mutedInk" weight={weight.strong}>
                {completedLabel()}
              </Label>
            </View>
            <If when={completedExpanded()}>
              <Each of={groups().completedChains} key={(chain) => chain.key}>
                {(chain) => (
                  <ChainPlanFrame
                    chain={chain}
                    tablet={props.tablet}
                    onOpen={props.onOpen}
                    onConnect={(from, to) => void editing.connect(from, to)}
                    onConnectFrom={(tasks, id) =>
                      editing.startConnecting(tasks, id)
                    }
                  />
                )}
              </Each>
            </If>
          </View>
        </If>
        <If when={props.tablet}>
          <Label variant="caption" tone="muted">
            {uiText("dragToMakeWait")}
          </Label>
        </If>
        <editing.Dialogs />
      </View>
    </If>
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
