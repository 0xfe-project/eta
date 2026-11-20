import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { taskDropZones } from "./drag";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import {
  dependentsOf,
  isWaiting,
  runningFor,
  stepOf,
  taskDay,
  taskTime,
} from "./facts";
import { progressColor, SubtreeGlyph, TaskGlyph, tones } from "./status";

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
  const children = () =>
    host
      .tasks()
      .filter((task) => task.parentId === props.task.id)
      .sort((a, b) => a.number - b.number);
  const isParent = () => !!props.task.subtasks?.total;
  const cancelled = () =>
    props.task.status === "blocked"
      ? props.task.waitingOn?.find(
          (edge) => edge.state === "cancelled" && edge.via === null,
        )
      : undefined;
  const footer = () => {
    const task = props.task;
    const dependents = dependentsOf(task, host.tasks()).length;
    if (task.status === "done" || task.status === "cancelled")
      return taskDay(task.updatedAt);
    if (task.status === "in_review" && dependents)
      return uiText("taskLetGo", { count: dependents });
    if (dependents)
      return uiText(dependents === 1 ? "taskUnlocks" : "taskUnlocksMany", {
        count: dependents,
      });
    return taskTime(task);
  };
  const summary = () => {
    const counts = (status: BoardTaskStatus) =>
      children().filter((task) => task.status === status).length;
    return [
      ["taskCountDone", counts("done")],
      ["taskCountInReview", counts("in_review")],
      ["taskCountRunning", counts("in_progress")],
      ["taskCountWaiting", counts("todo")],
      ["taskCountBlocked", counts("blocked")],
    ] as const;
  };
  const nowThen = () => {
    const now = children().find((task) => task.status === "in_progress");
    const next = children().find((task) => task.status === "todo");
    return [
      now && uiText("taskNow", { title: now.title }),
      next && uiText("taskThen", { title: next.title }),
    ]
      .filter(Boolean)
      .join(" · ");
  };
  async function startNow() {
    const edges = (props.task.waitingOn ?? []).filter(
      (edge) => edge.state === "cancelled" && edge.via === null,
    );
    await host.action(async () => {
      for (const edge of edges)
        await host.call("tasks", "removeDependency", {
          taskId: props.task.id,
          dependsOn: edge.taskId,
        });
    });
  }
  return (
    <View
      style={{
        paddingRight: isParent() ? 3 : 0,
        paddingBottom: isParent() ? 3 : 0,
      }}
    >
      <If when={isParent()}>
        <View
          style={{
            position: "absolute",
            top: 3,
            left: 3,
            right: 0,
            bottom: 0,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
          }}
        />
      </If>
      <View
        role="button"
        accessibilityLabel={props.task.title}
        onPressDown={props.draggable ? gesture.onPressDown : undefined}
        onPanStart={props.draggable ? gesture.onPanStart : undefined}
        onPanEnd={props.draggable ? gesture.onPanEnd : undefined}
        onPress={() => props.onOpen()}
        hoverStyle={{ backgroundColor: c().selected }}
        style={{
          paddingVertical: 7.2,
          paddingHorizontal: 9,
          gap: 3.6,
          borderWidth: 1,
          borderLeftWidth: props.task.status === "blocked" ? 2 : 1,
          borderColor: isParent() ? c().strong : c().border,
          borderLeftColor:
            props.task.status === "blocked"
              ? c().red
              : isParent()
                ? c().strong
                : c().border,
          backgroundColor: c().canvas,
          cursor: props.draggable ? "grab" : "pointer",
          opacity: props.drag.active() === props.task.id ? 0.65 : 1,
        }}
      >
        <If when={parent()}>
          {(entry) => (
            <View style={{ ...row, gap: 6 }}>
              <Label size={12} line={16} tone="muted" lines={1}>
                {entry().title}
              </Label>
              <Label size={12} line={16} tone="muted">
                ›
              </Label>
              <Label size={12} line={16} tone="muted" style={{ flexShrink: 0 }}>
                {uiText("step", {
                  value1: stepOf(props.task, host.tasks()),
                })}
              </Label>
            </View>
          )}
        </If>
        <View style={{ ...row, justifyContent: "space-between" }}>
          <If
            when={isParent()}
            else={
              <Label size={12} line={16} tone="muted">
                {`#${props.task.number}`}
              </Label>
            }
          >
            <View style={{ ...row, gap: 6 }}>
              <SubtreeGlyph size={10} />
              <Label size={12} line={16} tone="mutedInk">
                {`#${props.task.number}`}
              </Label>
              <Label size={12} line={16} tone="mutedInk">
                ·
              </Label>
              <Label size={12} line={16} tone="mutedInk">
                {uiText("taskSubtaskCount", {
                  count: props.task.subtasks?.total ?? 0,
                })}
              </Label>
            </View>
            <View style={{ ...row, gap: 4 }}>
              <TaskGlyph status={props.task.status} size={10} />
              <Label size={12} line={16} tone={tones[props.task.status]}>
                {uiText("taskAuto")}
              </Label>
            </View>
          </If>
          <If when={!isParent()}>
            <If when={props.task.status === "in_review"}>
              <Label
                size={12}
                line={16}
                tone="amber"
                style={{ backgroundColor: c().amberFill, paddingHorizontal: 5 }}
              >
                {uiText("forYouToCheck")}
              </Label>
            </If>
            <If when={props.task.status === "in_progress"}>
              <View style={{ ...row, gap: 4 }}>
                <View
                  style={{ width: 6, height: 6, backgroundColor: c().blue }}
                />
                <Label size={12} line={16} tone="blue">
                  {runningFor(props.task)}
                </Label>
              </View>
            </If>
            <If when={isWaiting(props.task)}>
              <Icon name="lock" size={11} tone="mutedInk" />
            </If>
            <If
              when={
                props.task.status === "done" || props.task.status === "blocked"
              }
            >
              <TaskGlyph status={props.task.status} size={11} />
            </If>
          </If>
        </View>
        <Label line={19.25} lines={4}>
          {props.task.title}
        </Label>
        <If when={isParent()}>
          <View style={{ ...row, gap: 2, height: 4 }}>
            <Each of={children()} key={(task) => task.id}>
              {(task) => (
                <View
                  style={{
                    flex: 1,
                    height: 4,
                    backgroundColor: progressColor(task().status, c()),
                  }}
                />
              )}
            </Each>
          </View>
          <If when={nowThen()}>
            <View style={{ ...row, gap: 5, alignItems: "flex-start" }}>
              <View
                style={{
                  width: 5,
                  height: 5,
                  marginTop: 5,
                  backgroundColor: c().blue,
                }}
              />
              <Label
                size={12}
                line={16}
                tone="mutedInk"
                lines={2}
                style={{ flex: 1 }}
              >
                {nowThen()}
              </Label>
            </View>
          </If>
          <View
            style={{
              ...row,
              alignItems: "flex-start",
              justifyContent: "space-between",
            }}
          >
            <Label size={12} line={16} tone="muted" style={{ flex: 1 }}>
              {summary()
                .filter(([, count]) => count)
                .map(([key, count]) => uiText(key, { count }))
                .join(" · ")}
            </Label>
            <Label size={12} line={16} tone="muted">
              ›
            </Label>
          </View>
        </If>
        <If
          when={
            !isParent() && isWaiting(props.task)
              ? props.task.waitingOn?.[0]
              : undefined
          }
        >
          {(dependency) => (
            <View
              style={{
                ...row,
                gap: 5,
                marginTop: 2,
                paddingVertical: 2,
                paddingHorizontal: 6,
                borderWidth: 1,
                borderColor: c().strong,
              }}
            >
              <Icon name="lock" size={10} />
              <Label size={12} line={16} lines={1} style={{ flex: 1 }}>
                {uiText("waitsFor", { title: dependency().title })}
              </Label>
            </View>
          )}
        </If>
        <If when={cancelled()}>
          {(edge) => (
            <>
              <Label size={12} line={16} tone="mutedInk">
                {uiText("taskBlockedReason", { title: edge().title })}
              </Label>
              <BlockedAction
                label={uiText("stopWaitingStartNow")}
                onPress={() => void startNow()}
              />
              <BlockedAction
                label={uiText("waitForAnother")}
                onPress={props.onOpen}
              />
            </>
          )}
        </If>
        <If when={!isParent() && !cancelled()}>
          <View
            style={{
              ...row,
              gap: 4,
              marginTop: 2,
              justifyContent: "space-between",
            }}
          >
            <Label size={12} line={16} tone="faint" lines={1}>
              {host.agent(
                props.task.assigneeAgentId ?? props.task.createdBy.agentId,
              )?.name ?? ""}
            </Label>
            <Label size={12} line={16} tone="faint" lines={1}>
              {footer()}
            </Label>
          </View>
        </If>
      </View>
    </View>
  );
}

function BlockedAction(props: { label: string; onPress: () => void }) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        alignSelf: "flex-start",
        paddingVertical: 3,
        paddingHorizontal: 6,
        borderWidth: 1,
        borderColor: c().strong,
        cursor: "pointer",
      }}
    >
      <Label size={12} line={16}>
        {props.label}
      </Label>
    </View>
  );
}
