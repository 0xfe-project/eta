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
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { isWaiting, runningFor, stepOf, taskDay, taskHint } from "./facts";
import { progressColor, statusName, TaskGlyph } from "./status";

/** A task the open one links to, as a list row: its glyph, `#N title`, what the link says, a chevron. */
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
      activeStyle={{ backgroundColor: `${c().selected}99` }}
      style={{
        ...row,
        height: link.height ?? 44,
        gap: 10,
        borderTopWidth: 1,
        borderBottomWidth: link.last ? 1 : 0,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ width: 20, alignItems: "center" }}>
        <TaskGlyph status={link.item.status} size={14} />
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
      <Icon name="right" size={14} tone="muted" />
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
              paddingVertical: cancelled() ? 14 : 10,
              paddingHorizontal: cancelled() ? 16 : 12,
              gap: cancelled() ? 8 : 10,
              borderWidth: 1,
              borderColor: cancelled() ? c().border : c().strong,
              borderLeftWidth: cancelled() ? 2 : 1,
              borderLeftColor: cancelled() ? c().red : c().strong,
            }}
          >
            <If when={!cancelled()}>
              <Icon name="lock" size={14} />
            </If>
            <View
              style={{
                gap: cancelled() ? 8 : 4,
                flex: cancelled() ? undefined : 1,
                alignSelf: "stretch",
              }}
            >
              <Label variant="small" weight={600}>
                {cancelled()
                  ? uiText("thisTaskIsStuckAndNeeds")
                  : uiText("waitingForPrerequisites")}
              </Label>
              <Label variant="small">
                {cancelled() ? stuckBody() : waitingBody()}
              </Label>
              <If when={decidable()}>
                <View style={{ gap: 8 }}>
                  <Button
                    label={uiText("dontWaitStartNow")}
                    size={40}
                    labelVariant="small"
                    tone="primary"
                    disabled={props.submitting}
                    onPress={props.onResolve}
                  />
                  <Button
                    label={uiText("waitForAnotherTask")}
                    size={40}
                    labelVariant="small"
                    disabled={props.submitting}
                    onPress={props.onReplace}
                  />
                  <Button
                    label={uiText("cancelThisTask")}
                    size={40}
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
              paddingVertical: 14,
              paddingHorizontal: 16,
              gap: 8,
              marginBottom: props.tablet ? 0 : 22,
              borderWidth: 1,
              borderLeftWidth: 2,
              borderColor: c().border,
              borderLeftColor: c().red,
            }}
          >
            <View style={{ ...row, gap: props.tablet ? 6 : 8 }}>
              <Icon name="warning" size={props.tablet ? 14 : 16} />
              <Label variant="small" weight={600}>
                {uiText("thisTaskIsStuckAndNeeds")}
              </Label>
            </View>
            <Label variant="small">{stuckBody()}</Label>
            <View style={{ ...row, flexWrap: "wrap", gap: 6 }}>
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
        paddingVertical: props.tablet ? 3 : 4,
        paddingHorizontal: props.bare && props.tablet ? 0 : 8,
        borderWidth: props.bare ? 0 : 1,
        borderColor: c().strong,
        backgroundColor: props.bare ? undefined : c().canvas,
        opacity: props.disabled ? 0.45 : 1,
        cursor: props.disabled ? "default" : "pointer",
        flexShrink: 0,
      }}
    >
      <Label
        variant="caption"
        weight={props.tablet && props.bare ? 400 : 600}
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
            gap: 6,
            paddingVertical: 7,
            paddingHorizontal: 8,
            borderWidth: 1,
            borderColor: c().strong,
            cursor: "pointer",
          }}
        >
          <Label variant="caption" weight={600} style={{ flex: 1 }}>
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
          gap: 8,
          padding: 8,
          borderWidth: 1,
          borderColor: c().strong,
          cursor: "pointer",
        }}
      >
        <View style={{ ...row, alignItems: "flex-start", gap: 5, flex: 1 }}>
          <TaskGlyph status={props.task.status} size={12} />
          <Label variant="caption" weight={600} style={{ flex: 1 }}>
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
        <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
          <If when={before().length}>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
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
            <View style={{ marginTop: 22 }}>
              <Icon name="arrowRight" size={12} />
            </View>
          </If>
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <Label variant="caption" tone="muted">
              {" "}
            </Label>
            <View
              style={{
                ...row,
                justifyContent: "space-between",
                gap: 6,
                paddingVertical: 6,
                paddingHorizontal: 7,
                borderWidth: 2,
                borderColor: c().ink,
              }}
            >
              <Label variant="caption" weight={600}>
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
            <View style={{ marginTop: 22 }}>
              <Icon name="arrowRight" size={12} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
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
            gap: 8,
            paddingBottom: 22,
          }}
        >
          <If when={before().length}>
            <View style={{ width: 180, gap: 6, flexShrink: 0 }}>
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
            <View style={{ marginTop: 32 }}>
              <Icon name="arrowRight" size={14} tone="muted" />
            </View>
          </If>
          <View style={{ width: 206, gap: 6, flexShrink: 0 }}>
            <Label variant="caption" tone="muted">
              {" "}
            </Label>
            <View
              style={{
                ...row,
                justifyContent: "space-between",
                gap: 8,
                padding: 8,
                borderWidth: 2,
                borderColor: c().ink,
                backgroundColor: c().canvas,
              }}
            >
              <View style={{ ...row, gap: 5 }}>
                <TaskGlyph status={props.item.status} size={12} />
                <Label variant="caption" weight={600}>
                  {uiText("thisTask")}
                </Label>
              </View>
              <Label variant="caption" tone="muted">
                {own()}
              </Label>
            </View>
          </View>
          <If when={after().length}>
            <View style={{ marginTop: 32 }}>
              <Icon name="arrowRight" size={14} tone="muted" />
            </View>
            <View style={{ width: 180, gap: 6, flexShrink: 0 }}>
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
              paddingVertical: props.tablet ? 10 : 12,
              paddingHorizontal: props.tablet ? 12 : 14,
              gap: props.tablet ? 6 : 10,
              borderWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label
              variant="caption"
              tone="muted"
              style={{
                letterSpacing: props.tablet ? 1 : 0.8,
                textTransform: "uppercase",
              }}
            >
              {uiText("progress")}
            </Label>
            <View style={{ ...row, gap: 2, height: props.tablet ? 5 : 6 }}>
              <Each of={children()} key={(child) => child.taskId}>
                {(child) => (
                  <View
                    style={{
                      height: props.tablet ? 5 : 6,
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
                <View style={{ ...row, gap: 10, alignItems: "flex-start" }}>
                  <Label
                    variant="small"
                    tone="muted"
                    style={{ width: props.tablet ? 60 : 70 }}
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
            <Label weight={600} style={{ paddingBottom: props.tablet ? 4 : 8 }}>
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
                    height: props.tablet ? 28 : 32,
                    gap: 8,
                    borderTopWidth: 1,
                    borderBottomWidth:
                      index() === children().length - 1 ? 1 : 0,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <TaskGlyph status={child().status} size={12} />
                  <Label variant="caption" tone="muted" style={{ width: 24 }}>
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
      <View style={{ gap: 8 }}>
        <Label
          variant="caption"
          weight={600}
          tone="mutedInk"
          style={{ letterSpacing: 0.8, textTransform: "uppercase" }}
        >
          {uiText("progress")}
        </Label>
        <View style={{ ...row, gap: 2, height: 4 }}>
          <Each of={children()} key={(child) => child.taskId}>
            {(child) => (
              <View
                style={{
                  height: 4,
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
        <View style={{ gap: 4 }}>
          <Each
            of={highlights().filter(
              ([key, , value]) => key !== "Done" && !!value,
            )}
            key={(entry) => entry[0]}
          >
            {(entry) => (
              <View style={{ ...row, gap: 12, alignItems: "flex-start" }}>
                <Label variant="small" tone="muted" style={{ width: 64 }}>
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
          style={{ paddingBottom: 6 }}
        />
        <Each of={children()} key={(child) => child.taskId}>
          {(child, index) => (
            <TaskLink
              item={child()}
              height={48}
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
