import type { BoardTaskStatus, BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { taskDropZones } from "./drag";
import { View } from "nsh";
import { colors, Compact, Icon, Label, row } from "../../components";
import { dotSize } from "../../components/status-dot";
import { border, icon, opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ownerLine } from "./creator";
import {
  dependentsOf,
  isWaiting,
  runningFor,
  stepOf,
  taskDay,
  taskTime,
} from "./facts";
import { progressColor, SubtreeGlyph, TaskGlyph, tones } from "./status";
import { UsageLine } from "./usage";

export function BoardCard(props: {
  task: BoardTaskView;
  layout: Layout;
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
  const tablet = () => props.layout === "tablet";
  const isParent = () => !!props.task.subtasks?.total;
  /** The stacked look of a parent card, on desktop only. */
  const stacked = () => isParent() && !tablet();
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
      ["taskCountWaiting", tablet() ? 0 : counts("todo")],
      ["taskCountBlocked", tablet() ? 0 : counts("blocked")],
    ] as const;
  };
  const nowThen = () => {
    const now = children().find((task) => task.status === "in_progress");
    const next = children().find((task) => task.status === "todo");
    return [
      now && uiText("taskNow", { title: now.title }),
      next && !tablet() && uiText("taskThen", { title: next.title }),
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
    <Compact>
      <View
        style={{
          paddingRight: stacked() ? space[4] : 0,
          paddingBottom: stacked() ? space[4] : 0,
        }}
      >
        <If when={stacked()}>
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
          hoverStyle={{ borderColor: c().strong }}
          activeStyle={{ borderColor: c().strong }}
          style={{
            paddingVertical: space[8],
            paddingHorizontal: space[8],
            gap: tablet()
              ? isParent() || cancelled()
                ? space[4]
                : space[2]
              : space[4],
            borderWidth: 1,
            borderLeftWidth: props.task.status === "blocked" ? border.thick : 1,
            borderColor: stacked() ? c().strong : c().border,
            borderLeftColor:
              props.task.status === "blocked"
                ? c().red
                : stacked()
                  ? c().strong
                  : c().border,
            backgroundColor: c().canvas,
            cursor: props.draggable ? "grab" : "pointer",
            opacity: props.drag.active() === props.task.id ? opacity.muted : 1,
          }}
        >
          <If when={parent()}>
            {(entry) => (
              <View style={{ ...row, gap: space[4] }}>
                <Label variant="small" tone="muted" lines={1}>
                  {entry().title}
                </Label>
                <Label variant="small" tone="muted">
                  ›
                </Label>
                <Label variant="small" tone="muted" style={{ flexShrink: 0 }}>
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
                <Label variant="small" tone="muted">
                  {`#${props.task.number}`}
                </Label>
              }
            >
              <If
                when={!tablet()}
                else={
                  <Label variant="small" tone="muted" style={{ flex: 1 }}>
                    {`#${props.task.number} · ${uiText("taskSubtaskCount", {
                      count: props.task.subtasks?.total ?? 0,
                    })}`}
                  </Label>
                }
              >
                <View style={{ ...row, gap: space[4] }}>
                  <SubtreeGlyph size={icon.sm} />
                  <Label variant="small" tone="mutedInk">
                    {`#${props.task.number}`}
                  </Label>
                  <Label variant="small" tone="mutedInk">
                    ·
                  </Label>
                  <Label variant="small" tone="mutedInk">
                    {uiText("taskSubtaskCount", {
                      count: props.task.subtasks?.total ?? 0,
                    })}
                  </Label>
                </View>
              </If>
              <View style={{ ...row, gap: space[4] }}>
                <If when={!tablet()}>
                  <TaskGlyph status={props.task.status} size={icon.sm} />
                </If>
                <Label variant="small" tone={tones[props.task.status]}>
                  {uiText("taskAuto")}
                </Label>
              </View>
            </If>
            <If when={!isParent()}>
              <If when={props.task.status === "in_review"}>
                <If
                  when={!tablet()}
                  else={
                    <Label variant="small" tone="warning" lines={1}>
                      {uiText("forYouToCheck2")}
                    </Label>
                  }
                >
                  <Label
                    variant="small"
                    tone="warning"
                    style={{
                      backgroundColor: c().warningFill,
                      paddingHorizontal: space[4],
                    }}
                  >
                    {uiText("forYouToCheck")}
                  </Label>
                </If>
              </If>
              <If when={props.task.status === "in_progress"}>
                <If
                  when={!tablet()}
                  else={
                    <Label variant="small" tone="blue">
                      {`■ ${runningFor(props.task)}`}
                    </Label>
                  }
                >
                  <View style={{ ...row, gap: space[4] }}>
                    <View
                      style={{
                        width: dotSize,
                        height: dotSize,
                        backgroundColor: c().blue,
                      }}
                    />
                    <Label variant="small" tone="blue">
                      {runningFor(props.task)}
                    </Label>
                  </View>
                </If>
              </If>
              <If when={isWaiting(props.task)}>
                <Icon
                  name="lock"
                  size={icon.sm}
                  tone={tablet() ? "ink" : "mutedInk"}
                />
              </If>
              <If
                when={
                  !tablet() &&
                  (props.task.status === "done" ||
                    props.task.status === "blocked")
                }
              >
                <TaskGlyph status={props.task.status} size={icon.sm} />
              </If>
            </If>
          </View>
          <Label lines={4}>{props.task.title}</Label>
          <If when={isParent()}>
            <View style={{ ...row, gap: space[2], height: space[4] }}>
              <Each of={children()} key={(task) => task.id}>
                {(task) => (
                  <View
                    style={{
                      flex: 1,
                      height: space[4],
                      backgroundColor: progressColor(task().status, c()),
                    }}
                  />
                )}
              </Each>
            </View>
            <If when={nowThen()}>
              <View style={{ ...row, gap: space[4], alignItems: "flex-start" }}>
                <If when={!tablet()}>
                  <View
                    style={{
                      width: dotSize,
                      height: dotSize,
                      marginTop: space[4],
                      backgroundColor: c().blue,
                    }}
                  />
                </If>
                <Label
                  variant="small"
                  tone={tablet() ? "muted" : "mutedInk"}
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
              <Label variant="small" tone="muted" style={{ flex: 1 }}>
                {summary()
                  .filter(([, count]) => count)
                  .map(([key, count]) => uiText(key, { count }))
                  .join(" · ")}
              </Label>
              <If when={!tablet()}>
                <Label variant="small" tone="muted">
                  ›
                </Label>
              </If>
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
                  gap: space[4],
                  marginTop: tablet() ? 0 : space[2],
                  paddingVertical: tablet() ? 1 : space[2],
                  paddingHorizontal: tablet() ? space[4] : space[8],
                  borderWidth: 1,
                  borderColor: c().strong,
                }}
              >
                <Icon name="lock" size={icon.sm} />
                <Label
                  variant="small"
                  lines={1}
                  tone={tablet() ? "mutedInk" : "ink"}
                  style={{ flex: 1 }}
                >
                  {uiText("waitsFor", { title: dependency().title })}
                </Label>
              </View>
            )}
          </If>
          <If when={cancelled()}>
            {(edge) => (
              <>
                <Label variant="small" tone="mutedInk">
                  {uiText("taskBlockedReason", { title: edge().title })}
                </Label>
                <BlockedAction
                  label={uiText("stopWaitingStartNow")}
                  stretch={tablet()}
                  onPress={() => void startNow()}
                />
                <BlockedAction
                  label={uiText("waitForAnother")}
                  stretch={tablet()}
                  onPress={props.onOpen}
                />
              </>
            )}
          </If>
          <If when={!isParent() && !cancelled()}>
            <View
              style={{
                ...row,
                gap: space[4],
                marginTop: space[2],
                justifyContent: "space-between",
              }}
            >
              <Label variant="small" tone="faint" lines={1}>
                {ownerLine(props.task, host.agent)}
              </Label>
              <Label variant="small" tone="faint" lines={1}>
                {footer()}
              </Label>
            </View>
          </If>
          <UsageLine
            task={props.task}
            model={!tablet()}
            rate
            style={{ justifyContent: "space-between" }}
          />
        </View>
      </View>
    </Compact>
  );
}

function BlockedAction(props: {
  label: string;
  stretch?: boolean;
  onPress: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        alignSelf: props.stretch ? "stretch" : "flex-start",
        paddingVertical: props.stretch ? space[2] : space[4],
        paddingHorizontal: props.stretch ? space[4] : space[8],
        borderWidth: 1,
        borderColor: c().strong,
        cursor: "pointer",
      }}
    >
      <Label variant="small">{props.label}</Label>
    </View>
  );
}
