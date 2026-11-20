import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { taskDropZones } from "./drag";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";

export function BoardCard(props: {
  task: BoardTaskView;
  onOpen: () => void;
  drag: ReturnType<typeof taskDropZones<BoardTaskStatus>>;
  draggable: boolean;
}) {
  const host = useHost();
  const c = colors();
  const gesture = props.drag.gesture(props.task.id);
  const parent = () =>
    host.tasks().find((task) => task.id === props.task.parentId);
  return (
    <View
      role="button"
      accessibilityLabel={props.task.title}
      onPressDown={props.draggable ? gesture.onPressDown : undefined}
      onPanStart={props.draggable ? gesture.onPanStart : undefined}
      onPanEnd={props.draggable ? gesture.onPanEnd : undefined}
      onPress={() => props.onOpen()}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        padding: 9,
        gap: 3,
        borderWidth: 1,
        borderLeftWidth: props.task.status === "blocked" ? 2 : 1,
        borderLeftColor: props.task.status === "blocked" ? c().red : c().border,
        borderColor: c().border,
        backgroundColor: c().canvas,
        cursor: props.draggable ? "grab" : "pointer",
        opacity: props.drag.active() === props.task.id ? 0.65 : 1,
      }}
    >
      <If when={parent()}>
        {(entry) => (
          <Label size={12} tone="muted" lines={1}>
            {entry().title}
          </Label>
        )}
      </If>
      <View style={{ ...row, justifyContent: "space-between" }}>
        <Label size={12} tone="muted">
          {`#${props.task.number}`}
        </Label>
        <If when={props.task.status === "in_review"}>
          <Label
            size={12}
            tone="amber"
            style={{ backgroundColor: c().amberFill, paddingHorizontal: 4 }}
          >
            {uiText("forYouToCheck")}
          </Label>
        </If>
        <If when={props.task.status === "in_progress"}>
          <Label size={12} tone="blue">
            {`▪ ${(props.task.runStatus ?? "In progress").replaceAll(
              "_",
              " ",
            )}`}
          </Label>
        </If>
      </View>
      <Label line={20}>{props.task.title}</Label>
      <If when={props.task.waitingOn?.[0]}>
        {(dependency) => (
          <Label
            size={12}
            lines={1}
            style={{
              borderWidth: 1,
              borderColor: c().strong,
              paddingHorizontal: 5,
            }}
          >
            {uiText("waitsFor", { title: dependency().title })}
          </Label>
        )}
      </If>
      <If when={props.task.subtasks}>
        {(subtasks) => (
          <View style={{ gap: 3 }}>
            <View style={{ ...row, backgroundColor: c().border, height: 4 }}>
              <View
                style={{
                  backgroundColor: c().green,
                  height: 4,
                  width: `${(subtasks().done / Math.max(1, subtasks().total)) * 100}%`,
                }}
              />
            </View>
            <Label size={12} tone="muted">
              {uiText("subtasksCompleted", {
                done: subtasks().done,
                total: subtasks().total,
              })}
            </Label>
          </View>
        )}
      </If>
      <View style={{ ...row, gap: 4, justifyContent: "space-between" }}>
        <Label size={12} tone="faint" lines={1}>
          {host.agent(
            props.task.assigneeAgentId ?? props.task.createdBy.agentId,
          )?.name ?? ""}
        </Label>
        <Label size={12} tone="faint">
          {relativeTime(props.task.updatedAt)}
        </Label>
      </View>
    </View>
  );
}
