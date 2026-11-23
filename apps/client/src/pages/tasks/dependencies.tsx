import type {
  BoardTaskDetail,
  BoardTaskStatus,
  BoardTaskView,
  TaskDependencyView,
  TaskRefView,
} from "@eta/client-contracts";
import { View } from "nsh";
import { Button, Caption, colors, Icon, Label, row } from "../../components";
import { canHover } from "../../components/menu";
import {
  border,
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { isWaiting, runningFor, stepOf, taskDay, taskHint } from "./facts";
import { progressColor, statusName, TaskGlyph } from "./status";

/** A task the open one links to, as a list row: its glyph, `#N title`, what the link says, a chevron. */
/** The neighbour strip's columns: the tasks before and after, and this task's own card. */
const stripWidth = { side: 180, own: 208 } as const;

/** A highlight's label column on the parent's progress card. */
const highlightWidth = { tablet: 60, regular: 72 } as const;

/** A subtask's segment in the parent's progress bar. */
const progressHeight = (tablet?: boolean) => (tablet ? space[4] : space[8]);

/** A subtask's row under its parent. */
const subtaskHeight = 48;

export function TaskLink(link: {
  item: {
    taskId: string;
    number: number;
    title: string;
    status: BoardTaskStatus;
  };
  suffix?: string;
  tone?: "blue" | "warning";
  /** Subtask rows stand 48 high, the rest 44. */
  height?: number;
  /** The list's last row closes it with a bottom border. */
  last?: boolean;
  onTask: (id: string) => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={link.item.title}
      onPress={() => link.onTask(link.item.taskId)}
      // A touch leaves no hover behind: the row fills only while pressed there.
      hoverStyle={canHover ? { backgroundColor: c().selected } : undefined}
      activeStyle={{ backgroundColor: c().selectedSoft }}
      style={{
        ...row,
        height: link.height ?? control.touch,
        gap: space[8],
        borderTopWidth: 1,
        borderBottomWidth: link.last ? 1 : 0,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ width: space[20], alignItems: "center" }}>
        <TaskGlyph status={link.item.status} size={icon.md} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label variant="small" lines={1}>
          {`#${link.item.number} ${link.item.title}`}
        </Label>
        <If when={link.suffix}>
          <Label variant="caption" lines={1} tone={link.tone ?? "muted"}>
            {link.suffix}
          </Label>
        </If>
      </View>
      <Icon name="right" size={icon.md} tone="muted" />
    </View>
  );
}
export function Prerequisites(props: {
  item: BoardTaskDetail;
  submitting: boolean;
  compact?: boolean;
  /** The compact card at tablet's sizes. */
  tablet?: boolean;
  onResolve: () => void;
  onReplace: () => void;
  onCancel: () => void;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const waiting = () => props.item.waitingOn ?? [];
  const cancelled = () => waiting().some((edge) => edge.state === "cancelled");
  const cancelledEdges = () =>
    waiting().filter((edge) => edge.state === "cancelled");
  const decidable = () =>
    waiting().some((edge) => edge.state === "cancelled" && edge.via === null) &&
    !props.item.archivedAt;
  const links = () =>
    waiting().filter((edge) => edge.state === "cancelled" || edge.via !== null);
  const linkLabel = (edge: { via: number | null; number: number }) =>
    props.item.ancestors?.some((item) => item.number === edge.via)
      ? uiText("openParentTask", { via: edge.via })
      : uiText("seeWhyWasCancelled", { number: edge.number });
  const openLink = (edge: { via: number | null; taskId: string }) =>
    props.onTask(
      props.item.ancestors?.find((item) => item.number === edge.via)?.taskId ??
        edge.taskId,
    );
  const stuckBody = () => {
    const edges = cancelledEdges();
    const join = edges
      .map((edge) => `“${edge.title}” (#${edge.number})`)
      .join(", ");
    const cancelledAt = Math.max(
      0,
      ...edges.map(
        (edge) =>
          host
            .list<BoardTaskView>("tasks", "archived")
            .concat(host.tasks())
            .find((task) => task.id === edge.taskId)?.updatedAt ?? 0,
      ),
    );
    const executor = host.agent(
      props.item.assigneeAgentId ?? props.item.createdBy.agentId,
    )?.name;
    return cancelledAt && executor
      ? uiText("stuckBody", {
          join,
          ago:
            Date.now() - cancelledAt < 86_400_000
              ? uiText("taskAgo", { time: relativeTime(cancelledAt) })
              : taskDay(cancelledAt),
          executor,
        })
      : uiText("wasCancelledThisTaskStaysBlocked", { join });
  };
  const waitingBody = () => {
    const executor = host.agent(
      props.item.assigneeAgentId ?? props.item.createdBy.agentId,
    )?.name;
    const join = waiting()
      .map((edge) => `“${edge.title}”`)
      .join(", ");
    return executor
      ? uiText("taskWaitingBody", { join, executor })
      : uiText("waitingForThisTaskStartsWhen", { join });
  };
  return (
    <If
      when={
        waiting().length &&
        (props.item.status === "todo" || props.item.status === "blocked")
      }
    >
      <If
        when={props.compact}
        else={
          <View
            style={{
              ...(cancelled() ? {} : row),
              alignItems: "flex-start",
              paddingVertical: cancelled() ? space[16] : space[12],
              paddingHorizontal: cancelled() ? space[16] : space[12],
              gap: space[8],
              borderWidth: 1,
              borderColor: cancelled() ? c().border : c().strong,
              borderLeftWidth: cancelled() ? border.thick : 1,
              borderLeftColor: cancelled() ? c().red : c().strong,
            }}
          >
            <If when={!cancelled()}>
              <Icon name="lock" size={icon.md} />
            </If>
            <View
              style={{
                gap: cancelled() ? space[8] : space[4],
                flex: cancelled() ? undefined : 1,
                alignSelf: "stretch",
              }}
            >
              <Label variant="small" weight={weight.strong}>
                {cancelled()
                  ? uiText("thisTaskIsStuckAndNeeds")
                  : uiText("waitingForPrerequisites")}
              </Label>
              <Label variant="small">
                {cancelled() ? stuckBody() : waitingBody()}
              </Label>
              <If when={decidable()}>
                <View style={{ gap: space[8] }}>
                  <Button
                    label={uiText("dontWaitStartNow")}
                    size={control.touch}
                    labelVariant="small"
                    tone="primary"
                    disabled={props.submitting}
                    onPress={props.onResolve}
                  />
                  <Button
                    label={uiText("waitForAnotherTask")}
                    size={control.touch}
                    labelVariant="small"
                    disabled={props.submitting}
                    onPress={props.onReplace}
                  />
                  <Button
                    label={uiText("cancelThisTask")}
                    size={control.touch}
                    labelVariant="small"
                    disabled={props.submitting}
                    onPress={props.onCancel}
                  />
                </View>
              </If>
              <Each of={links()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <View
                    role="button"
                    onPress={() => openLink(edge())}
                    style={{ cursor: "pointer", alignSelf: "flex-start" }}
                  >
                    <Label variant="small" tone="blue">
                      {linkLabel(edge())}
                    </Label>
                  </View>
                )}
              </Each>
            </View>
          </View>
        }
      >
        <If when={cancelled()}>
          <View
            style={{
              paddingVertical: space[16],
              paddingHorizontal: space[16],
              gap: space[8],
              marginBottom: props.tablet ? 0 : space[24],
              borderWidth: 1,
              borderLeftWidth: border.thick,
              borderColor: c().border,
              borderLeftColor: c().red,
            }}
          >
            <View style={{ ...row, gap: props.tablet ? space[4] : space[8] }}>
              <Icon name="warning" size={icon.md} />
              <Label variant="small" weight={weight.strong}>
                {uiText("thisTaskIsStuckAndNeeds")}
              </Label>
            </View>
            <Label variant="small">{stuckBody()}</Label>
            <View style={{ ...row, flexWrap: "wrap", gap: space[4] }}>
              <If when={decidable()}>
                <StuckAction
                  label={uiText("dontWaitStartNow")}
                  tablet={props.tablet}
                  disabled={props.submitting}
                  onPress={props.onResolve}
                />
                <StuckAction
                  label={uiText("waitForAnotherTask")}
                  tablet={props.tablet}
                  disabled={props.submitting}
                  onPress={props.onReplace}
                />
                <StuckAction
                  label={uiText("cancelThisTask")}
                  tablet={props.tablet}
                  disabled={props.submitting}
                  onPress={props.onCancel}
                />
              </If>
              <Each of={links()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <StuckAction
                    label={linkLabel(edge())}
                    tablet={props.tablet}
                    bare
                    onPress={() => openLink(edge())}
                  />
                )}
              </Each>
            </View>
          </View>
        </If>
      </If>
    </If>
  );
}

function StuckAction(props: {
  label: string;
  bare?: boolean;
  tablet?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        paddingVertical: space[4],
        paddingHorizontal: props.bare && props.tablet ? 0 : space[8],
        borderWidth: props.bare ? 0 : 1,
        borderColor: c().strong,
        backgroundColor: props.bare ? undefined : c().canvas,
        opacity: props.disabled ? opacity.disabled : 1,
        cursor: props.disabled ? "default" : "pointer",
        flexShrink: 0,
      }}
    >
      <Label
        variant="caption"
        weight={props.tablet && props.bare ? weight.regular : weight.strong}
        tone={props.tablet && props.bare ? "mutedInk" : "ink"}
      >
        {props.label}
      </Label>
    </View>
  );
}

/** One task the open one waits for, or that waits for it, in the Before / After strip. */
function StripCard(props: {
  task: { taskId: string; title: string; status: BoardTaskStatus };
  state: string;
  tablet?: boolean;
  onTask: (id: string) => void;
}) {
  const c = colors();
  return (
    <If
      when={!props.tablet}
      else={
        <View
          role="button"
          accessibilityLabel={props.task.title}
          onPress={() => props.onTask(props.task.taskId)}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            justifyContent: "space-between",
            gap: space[4],
            paddingVertical: space[8],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().strong,
            cursor: "pointer",
          }}
        >
          <Label variant="caption" weight={weight.strong} style={{ flex: 1 }}>
            {props.task.title}
          </Label>
          <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
            {props.state}
          </Label>
        </View>
      }
    >
      <View
        role="button"
        accessibilityLabel={props.task.title}
        onPress={() => props.onTask(props.task.taskId)}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          ...row,
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: space[8],
          padding: space[8],
          borderWidth: 1,
          borderColor: c().strong,
          cursor: "pointer",
        }}
      >
        <View
          style={{ ...row, alignItems: "flex-start", gap: space[4], flex: 1 }}
        >
          <TaskGlyph status={props.task.status} size={icon.sm} />
          <Label variant="caption" weight={weight.strong} style={{ flex: 1 }}>
            {props.task.title}
          </Label>
        </View>
        <Label variant="caption" tone="muted" style={{ flexShrink: 0 }}>
          {props.state}
        </Label>
      </View>
    </If>
  );
}

/** What the open task waits for, itself, and what waits for it, left to right. */
export function NeighbourStrip(props: {
  item: BoardTaskDetail;
  tablet?: boolean;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const before = () => props.item.dependsOn ?? [];
  const after = () => props.item.dependents ?? [];
  const beforeState = (edge: TaskDependencyView) =>
    edge.status === "cancelled"
      ? statusName("cancelled")
      : edge.status === "done"
        ? uiText("taskDone")
        : edge.state === "resolved"
          ? uiText("taskDelivered")
          : edge.status === "in_progress"
            ? uiText("running")
            : statusName(edge.status);
  const own = () =>
    props.item.status === "in_progress"
      ? uiText("running")
      : props.item.status === "in_review"
        ? uiText("forYouToCheck2")
        : statusName(props.item.status);
  return (
    <>
      <If when={props.tablet && (before().length || after().length)}>
        <View style={{ ...row, alignItems: "flex-start", gap: space[8] }}>
          <If when={before().length}>
            <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
              <Label variant="caption" tone="muted">
                {uiText("taskBefore", { count: before().length })}
              </Label>
              <Each of={before()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <StripCard
                    task={edge()}
                    state={beforeState(edge())}
                    tablet
                    onTask={props.onTask}
                  />
                )}
              </Each>
            </View>
            {/* Half a card down, less half the arrow: level with the cards' middle. */}
            <View style={{ marginTop: space[20] }}>
              <Icon name="arrowRight" size={icon.sm} />
            </View>
          </If>
          <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
            <Label variant="caption" tone="muted">
              {" "}
            </Label>
            <View
              style={{
                ...row,
                justifyContent: "space-between",
                gap: space[4],
                paddingVertical: space[8],
                paddingHorizontal: space[8],
                borderWidth: border.thick,
                borderColor: c().ink,
              }}
            >
              <Label variant="caption" weight={weight.strong}>
                {uiText("thisTask")}
              </Label>
              <Label
                variant="caption"
                tone={props.item.status === "in_review" ? "warning" : "muted"}
              >
                {own()}
              </Label>
            </View>
          </View>
          <If when={after().length}>
            {/* Half a card down, less half the arrow: level with the cards' middle. */}
            <View style={{ marginTop: space[20] }}>
              <Icon name="arrowRight" size={icon.sm} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
              <Label variant="caption" tone="muted">
                {uiText("taskAfter", { count: after().length })}
              </Label>
              <Each of={after()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <StripCard
                    task={edge()}
                    state={uiText("taskWaits")}
                    tablet
                    onTask={props.onTask}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
      <If when={!props.tablet && (before().length || after().length)}>
        <View
          style={{
            ...row,
            alignItems: "flex-start",
            gap: space[8],
            paddingBottom: space[24],
          }}
        >
          <If when={before().length}>
            <View
              style={{ width: stripWidth.side, gap: space[4], flexShrink: 0 }}
            >
              <Label variant="caption" tone="muted">
                {uiText("taskBefore", { count: before().length })}
              </Label>
              <Each of={before()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <StripCard
                    task={edge()}
                    state={beforeState(edge())}
                    onTask={props.onTask}
                  />
                )}
              </Each>
            </View>
            <View style={{ marginTop: space[32] }}>
              <Icon name="arrowRight" size={icon.md} tone="muted" />
            </View>
          </If>
          <View style={{ width: stripWidth.own, gap: space[4], flexShrink: 0 }}>
            <Label variant="caption" tone="muted">
              {" "}
            </Label>
            <View
              style={{
                ...row,
                justifyContent: "space-between",
                gap: space[8],
                padding: space[8],
                borderWidth: border.thick,
                borderColor: c().ink,
                backgroundColor: c().canvas,
              }}
            >
              <View style={{ ...row, gap: space[4] }}>
                <TaskGlyph status={props.item.status} size={icon.sm} />
                <Label variant="caption" weight={weight.strong}>
                  {uiText("thisTask")}
                </Label>
              </View>
              <Label variant="caption" tone="muted">
                {own()}
              </Label>
            </View>
          </View>
          <If when={after().length}>
            <View style={{ marginTop: space[32] }}>
              <Icon name="arrowRight" size={icon.md} tone="muted" />
            </View>
            <View
              style={{ width: stripWidth.side, gap: space[4], flexShrink: 0 }}
            >
              <Label variant="caption" tone="muted">
                {uiText("taskAfter", { count: after().length })}
              </Label>
              <Each of={after()} key={(edge) => edge.taskId}>
                {(edge) => (
                  <StripCard
                    task={edge()}
                    state={uiText("waitsForThis")}
                    onTask={props.onTask}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </>
  );
}
export function Subtasks(props: {
  item: BoardTaskDetail;
  tablet?: boolean;
  phone?: boolean;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const host = useHost();
  const children = () =>
    (props.item.children ?? []).filter((child) => child.status !== "cancelled");
  const titles = (status: BoardTaskStatus) =>
    children()
      .filter((item) => item.status === status)
      .map((item) => item.title)
      .join(", ");
  const highlights = () =>
    [
      ["Done", uiText("taskDone"), titles("done")],
      ["Now", uiText("taskProgressNow"), titles("in_progress")],
      [
        "Next",
        uiText("taskProgressNext"),
        children().find((item) => item.status === "todo")?.title ?? "",
      ],
      ["To review", uiText("taskProgressToReview"), titles("in_review")],
    ] as const;
  const board = (id: string) => host.tasks().find((task) => task.id === id);
  const hint = (child: TaskRefView) => {
    const task = board(child.taskId);
    if (!task) return statusName(child.status);
    if (task.status === "done")
      return uiText("step", { value1: stepOf(task, host.tasks()) ?? 1 });
    if (task.status === "in_progress") return `■ ${runningFor(task)}`;
    if (task.status === "in_review") return uiText("forYouToCheck2");
    return taskHint(task, host.tasks()) ?? statusName(task.status);
  };
  /** A subtask's line under its title on the phone: "Step 1 · Done", "Step 2 · Waits for #8". */
  const phoneHint = (child: TaskRefView) => {
    const task = board(child.taskId);
    if (!task) return statusName(child.status);
    if (task.status === "in_progress") return `■ ${runningFor(task)}`;
    if (task.status === "in_review") return uiText("forYouToCheck2");
    const step = stepOf(task, host.tasks()) ?? 1;
    const wait = task.waitingOn?.[0];
    const state =
      task.status === "done"
        ? uiText("taskDone")
        : isWaiting(task) && wait
          ? uiText("taskWaitsForNumber", { number: wait.number })
          : statusName(task.status);
    return uiText("taskStepState", { step, state });
  };
  return (
    <If
      when={props.phone}
      else={
        <>
          <View
            style={{
              paddingVertical: space[12],
              paddingHorizontal: props.tablet ? space[12] : space[16],
              gap: props.tablet ? space[4] : space[8],
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label
              variant="caption"
              tone="muted"
              tracking="caps"
              style={{ textTransform: "uppercase" }}
            >
              {uiText("progress")}
            </Label>
            <View
              style={{
                ...row,
                gap: space[2],
                height: progressHeight(props.tablet),
              }}
            >
              <Each of={children()} key={(child) => child.taskId}>
                {(child) => (
                  <View
                    style={{
                      height: progressHeight(props.tablet),
                      flex: 1,
                      backgroundColor: progressColor(child().status, c()),
                    }}
                  />
                )}
              </Each>
            </View>
            <If when={props.item.subtasks}>
              {(count) => (
                <Label variant="small" tone="mutedInk">
                  {uiText("ofDoneTheParentDoesNo", {
                    done: count().done,
                    total: count().total,
                  })}
                </Label>
              )}
            </If>
            <Each
              of={highlights().filter(([, , value]) => !!value)}
              key={(entry) => entry[0]}
            >
              {(entry) => (
                <View
                  style={{ ...row, gap: space[8], alignItems: "flex-start" }}
                >
                  <Label
                    variant="small"
                    tone="muted"
                    style={{
                      width: props.tablet
                        ? highlightWidth.tablet
                        : highlightWidth.regular,
                    }}
                  >
                    {entry()[1]}
                  </Label>
                  <Label
                    variant="small"
                    tone={entry()[0] === "To review" ? "warning" : "ink"}
                    style={{ flex: 1 }}
                  >
                    {entry()[2]}
                  </Label>
                </View>
              )}
            </Each>
          </View>
          <View>
            <Label
              weight={weight.strong}
              style={{ paddingBottom: props.tablet ? space[4] : space[8] }}
            >
              {`${uiText("subtasks")} ${props.item.subtasks?.done ?? 0}/${props.item.subtasks?.total ?? 0}`}
            </Label>
            <Each of={children()} key={(child) => child.taskId}>
              {(child, index) => (
                <View
                  role="button"
                  accessibilityLabel={child().title}
                  onPress={() => props.onTask(child().taskId)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    height: props.tablet ? control.md : space[32],
                    gap: space[8],
                    borderTopWidth: 1,
                    borderBottomWidth:
                      index() === children().length - 1 ? 1 : 0,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <TaskGlyph status={child().status} size={icon.sm} />
                  <Label
                    variant="caption"
                    tone="muted"
                    style={{ width: space[24] }}
                  >
                    {`#${child().number}`}
                  </Label>
                  <Label variant="small" lines={1} style={{ flex: 1 }}>
                    {child().title}
                  </Label>
                  <Label
                    variant="caption"
                    lines={1}
                    tone={
                      child().status === "in_review"
                        ? "warning"
                        : child().status === "in_progress"
                          ? "blue"
                          : props.tablet ||
                              (board(child().taskId) &&
                                isWaiting(board(child().taskId)!))
                            ? "mutedInk"
                            : "muted"
                    }
                  >
                    {hint(child())}
                  </Label>
                </View>
              )}
            </Each>
          </View>
        </>
      }
    >
      <View style={{ gap: space[8] }}>
        <Label
          tracking="caps"
          variant="caption"
          weight={weight.strong}
          tone="mutedInk"
          style={{ textTransform: "uppercase" }}
        >
          {uiText("progress")}
        </Label>
        <View style={{ ...row, gap: space[2], height: space[4] }}>
          <Each of={children()} key={(child) => child.taskId}>
            {(child) => (
              <View
                style={{
                  height: space[4],
                  flex: 1,
                  backgroundColor: progressColor(child().status, c()),
                }}
              />
            )}
          </Each>
        </View>
        <If when={props.item.subtasks}>
          {(count) => (
            <Label variant="small" tone="mutedInk">
              {uiText("ofDoneTheParentDoesNo", {
                done: count().done,
                total: count().total,
              })}
            </Label>
          )}
        </If>
        <View style={{ gap: space[4] }}>
          <Each
            of={highlights().filter(
              ([key, , value]) => key !== "Done" && !!value,
            )}
            key={(entry) => entry[0]}
          >
            {(entry) => (
              <View
                style={{ ...row, gap: space[12], alignItems: "flex-start" }}
              >
                <Label
                  variant="small"
                  tone="muted"
                  style={{ width: space[64] }}
                >
                  {entry()[1]}
                </Label>
                <Label
                  variant="small"
                  tone={entry()[0] === "To review" ? "warning" : "ink"}
                  style={{ flex: 1 }}
                >
                  {entry()[2]}
                </Label>
              </View>
            )}
          </Each>
        </View>
      </View>
      <View>
        <Caption
          text={uiText("taskSubtasksCount", {
            done: props.item.subtasks?.done ?? 0,
            total: props.item.subtasks?.total ?? 0,
          })}
          style={{ paddingBottom: space[8] }}
        />
        <Each of={children()} key={(child) => child.taskId}>
          {(child, index) => (
            <TaskLink
              item={child()}
              height={subtaskHeight}
              suffix={phoneHint(child())}
              tone={
                child().status === "in_review"
                  ? "warning"
                  : child().status === "in_progress"
                    ? "blue"
                    : undefined
              }
              last={index() === children().length - 1}
              onTask={props.onTask}
            />
          )}
        </Each>
      </View>
    </If>
  );
}
