import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import { Image, View } from "nsh";
import { Caption, colors, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";

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
