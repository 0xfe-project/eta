import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import { Image, View } from "nsh";
import { Caption, colors, focusRing, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { UsageLine } from "./usage";

export const statusKeys = {
  backlog: "backlog",
  todo: "taskToDo",
  in_progress: "taskInProgress",
  in_review: "taskInReview",
  done: "taskCompleted",
  blocked: "taskBlocked",
  cancelled: "taskCancelled",
} as const satisfies Record<BoardTaskStatus, Parameters<typeof uiText>[0]>;

export function statusName(status: BoardTaskStatus) {
  return uiText(statusKeys[status]);
}

const statusHints = {
  backlog: "statusHintBacklog",
  todo: "statusHintTodo",
  in_progress: "statusHintInProgress",
  in_review: "statusHintInReview",
  done: "statusHintDone",
  blocked: "statusHintBlocked",
  cancelled: "statusHintCancelled",
} as const satisfies Record<BoardTaskStatus, Parameters<typeof uiText>[0]>;

/** What moving a task to a status does, under its name in the status menu. */
export function statusHint(status: BoardTaskStatus, waiting = 0) {
  if (status === "cancelled" && waiting)
    return uiText(
      waiting === 1
        ? "statusHintCancelledDependent"
        : "statusHintCancelledDependents",
      { count: waiting },
    );
  return uiText(statusHints[status]);
}

export const tones = {
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
  return (
    <ShapeImage
      shape={statusShapes[props.status]
        .replaceAll("currentColor", c()[tones[props.status]])
        .replaceAll("paper", c().canvas)}
      size={props.size}
    />
  );
}

/** A parent's mark on its board card: the tree of its subtasks. */
export function SubtreeGlyph(props: { size?: number }) {
  const c = colors();
  return (
    <ShapeImage
      shape={`<path d="M2 3h4v3H2zM2 10h4v3H2zM6 4.5h4M6 11.5h4M10 4.5v7" fill="none" stroke="${c().mutedInk}"/>`}
      size={props.size}
    />
  );
}

function ShapeImage(props: { shape: string; size?: number }) {
  const src = () =>
    `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">${props.shape}</svg>`)}`;
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

const fills = {
  backlog: "selected",
  todo: "selected",
  in_progress: "blueFill",
  in_review: "amberFill",
  blocked: "redFill",
  done: "greenFill",
  cancelled: "selected",
} as const;

export function TaskStatus(props: { task: BoardTaskView }) {
  const c = colors();
  const waiting = () =>
    props.task.waitingOn?.length && props.task.status === "todo";
  return (
    <View
      style={{
        ...row,
        paddingVertical: 1,
        paddingLeft: waiting() ? 4 : 6,
        paddingRight: 6,
        gap: 4,
        flexShrink: 0,
        backgroundColor: waiting() ? c().canvas : c()[fills[props.task.status]],
        borderWidth: waiting() ? 1 : 0,
        borderColor: c().strong,
      }}
    >
      <If when={waiting()}>
        <Icon name="lock" size={12} tone="mutedInk" />
      </If>
      <Label
        variant="small"
        lines={1}
        tone={waiting() ? "mutedInk" : tones[props.task.status]}
      >
        {waiting()
          ? uiText("waitingForPrerequisites")
          : statusName(props.task.status)}
      </Label>
    </View>
  );
}

/** A parent's subtasks, oldest first, each as one coloured segment. */
export function subtasksOf(tasks: BoardTaskView[], parent: BoardTaskView) {
  return tasks
    .filter(
      (task) => task.parentId === parent.id && task.status !== "cancelled",
    )
    .sort((a, b) => a.number - b.number);
}

const segmentTones = {
  backlog: "border",
  todo: "border",
  in_progress: "blue",
  in_review: "amber",
  blocked: "red",
  done: "green",
  cancelled: "border",
} as const;

export function SubtaskSegments(props: {
  subtasks: BoardTaskView[];
  width?: number;
  gap?: number;
}) {
  const c = colors();
  return (
    <View style={{ ...row, gap: props.gap ?? 1, flexShrink: 0 }}>
      <Each of={props.subtasks} key={(task) => task.id}>
        {(task) => (
          <View
            style={{
              width: props.width ?? 5,
              height: 5,
              backgroundColor: c()[segmentTones[task().status]],
            }}
          />
        )}
      </Each>
    </View>
  );
}

/** The status pill of a task card in the transcript: glyph, then what it waits on. */
function TaskCardStatus(props: { task: BoardTaskView }) {
  const c = colors();
  const task = () => props.task;
  const waitingFor = () =>
    task().status === "todo" ? task().waitingOn?.[0] : undefined;
  const blocked = () => task().status === "blocked";
  const label = () => {
    const wait = waitingFor();
    if (wait) return uiText("taskWaitingForTitle", { title: wait.title });
    if (blocked()) return uiText("taskBlockedNeedsDecision");
    const total = task().subtasks?.total;
    return total
      ? `${statusName(task().status)} · ${task().subtasks?.done ?? 0}/${total}`
      : statusName(task().status);
  };
  return (
    <View
      style={{
        ...row,
        paddingVertical: 1,
        paddingLeft: 4,
        paddingRight: 6,
        gap: 4,
        flexShrink: 1,
        minWidth: 0,
        backgroundColor: waitingFor()
          ? c().canvas
          : blocked()
            ? c().selected
            : c()[fills[task().status]],
        borderWidth: waitingFor() ? 1 : 0,
        borderColor: c().strong,
      }}
    >
      <If when={!waitingFor()}>
        <TaskGlyph status={task().status} size={10} />
      </If>
      <Label
        variant="small"
        lines={1}
        tone={
          waitingFor() ? "mutedInk" : blocked() ? "ink" : tones[task().status]
        }
        style={{ flexShrink: 1, minWidth: 0 }}
      >
        {label()}
      </Label>
    </View>
  );
}

function runText(task: BoardTaskView) {
  if (task.status === "done") return uiText("taskRunDone");
  switch (task.runStatus) {
    case "completed":
      return uiText("taskRunDone");
    case "failed":
    case "interrupted":
      return uiText("taskRunStopped");
    case "running":
    case "starting":
      return uiText("taskRunRunning");
    case "queued":
      return uiText("taskRunQueued");
    default:
      return statusName(task.status);
  }
}

/** A subtask's segment in its parent's progress bar: what is not started yet stays grey. */
export function progressColor(
  status: BoardTaskStatus,
  c: ReturnType<ReturnType<typeof colors>>,
) {
  return status === "todo" || status === "backlog" || status === "cancelled"
    ? c.strong
    : c[tones[status]];
}

/**
 * A task card in the transcript. Its head line folds it, as a turn's process and a draft fold:
 * chevron, status, kind, number, title and status pill. The number and title are the way to the
 * task, and so is the body under the head while the card is open; pressing them is spent there and
 * does not also fold the card.
 */
export function TaskSummary(props: {
  task: BoardTaskView;
  subtasks?: BoardTaskView[];
  /** The phone transcript says the kind "Task" rather than "Task card". */
  phone?: boolean;
  /** Whether the body under the head line shows. */
  open: boolean;
  onToggle: () => void;
  controlRef?: (node: ViewRef) => void;
  onPress: () => void;
}) {
  const c = colors();
  const subtasks = () => props.subtasks ?? [];
  const now = () => subtasks().find((task) => task.status === "in_progress");
  const then = () =>
    subtasks().find(
      (task) => task.status === "todo" || task.status === "backlog",
    );
  const plan = () =>
    [
      now() && uiText("taskNow", { title: now()!.title }),
      then() && uiText("taskThen", { title: then()!.title }),
    ]
      .filter(Boolean)
      .join(" · ");
  const kind = () => uiText(props.phone ? "taskKind" : "taskCard");
  const openTask = () =>
    uiText("taskCardOpenTask", { number: props.task.number });
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View
        ref={(node) => props.controlRef?.(node)}
        role="button"
        accessibilityLabel={`${kind()} #${props.task.number} ${props.task.title}`}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c())}
        style={{
          ...row,
          paddingHorizontal: 10,
          paddingVertical: 6,
          gap: 8,
          cursor: "pointer",
        }}
      >
        <Icon
          name={props.open ? "down" : "right"}
          size={props.open ? 8 : 10}
          tone={props.open ? "muted" : "faint"}
        />
        <TaskGlyph status={props.task.status} size={12} />
        <Caption
          text={kind()}
          style={{ letterSpacing: 1.4, color: c().faint, flexShrink: 0 }}
        />
        <View
          role="link"
          accessibilityLabel={openTask()}
          onPress={() => props.onPress()}
          focusVisibleStyle={focusRing(c())}
          style={{ ...row, gap: 8, flex: 1, minWidth: 50, cursor: "pointer" }}
        >
          <Label variant="small" tone="muted">
            {`#${props.task.number}`}
          </Label>
          <Label
            variant="small"
            weight={500}
            lines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {props.task.title}
          </Label>
        </View>
        <TaskCardStatus task={props.task} />
      </View>
      <If when={props.open}>
        <View
          onPress={() => props.onPress()}
          focusable={false}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            cursor: "pointer",
          }}
        >
          <If
            when={subtasks().length}
            else={
              <View
                style={{
                  ...row,
                  paddingVertical: 8,
                  paddingHorizontal: 10,
                  gap: 12,
                  justifyContent: "space-between",
                }}
              >
                <Label variant="small" tone="muted" style={{ flexShrink: 0 }}>
                  {runText(props.task)}
                </Label>
                <UsageLine
                  task={props.task}
                  model={!props.phone}
                  rate
                  tone="mutedInk"
                />
              </View>
            }
          >
            <View style={{ paddingVertical: 8, paddingHorizontal: 10, gap: 6 }}>
              <View
                style={{ ...row, gap: 12, justifyContent: "space-between" }}
              >
                <SubtaskSegments subtasks={subtasks()} width={44} gap={4} />
                <UsageLine task={props.task} tone="mutedInk" />
              </View>
              <If when={plan()}>
                <Label variant="caption" tone="muted">
                  {plan()}
                </Label>
              </If>
            </View>
          </If>
        </View>
      </If>
    </View>
  );
}
