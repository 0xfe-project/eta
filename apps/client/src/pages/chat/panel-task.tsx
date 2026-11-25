import type {
  ArtifactView,
  TaskDependencyView,
  TaskRunView,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../components";
import { signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  DetailSkeleton,
  grow,
  Label,
  Markdown,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { settled } from "../../components/pending";
import { StatusDot } from "../../components/status-dot";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity } from "../tasks/activity";
import { actorLabel } from "../tasks/creator";
import {
  activeTaskRun,
  liveRuns,
  runClock,
  runDoingText,
  runElapsed,
} from "../tasks/run-log";
import { statusName, TaskGlyph } from "../tasks/status";
import { StatusSelect } from "../tasks/status-select";
import { TaskDetailDialogs } from "../tasks/task-detail-dialogs";
import { TaskDetailMissing } from "../tasks/task-detail-missing";
import { createTaskDetailState } from "../tasks/task-detail-state";
import { TaskCommentBox, TaskCommentHint } from "../tasks/task-fields";
import { TaskTopBar } from "../tasks/top-bar";
import { messageTime } from "./message-time";

/** How long a goal shows before "Expand full text". */
const goalPreview = 600;

/** The detail's side inset, on each part rather than the whole, so rows can reach both edges. */
const inset = space[12];

/** A row naming a task this one waits for or that waits for it. */
const dependencyRowHeight = 32;

/** A task opened in the conversation panel: under its tabs, compact. */
export function PanelTask(props: {
  id: string;
  layout: Layout;
  onClose: () => void;
  onTask: (id: string) => void;
  /** The conversation's preview, which the timeline's artifacts open in. */
  onArtifact: (artifact: ArtifactView, version?: number) => void;
}) {
  const c = colors();
  const host = useHost();
  const state = createTaskDetailState({ ...props, docked: true });
  const { task, activity, log } = state;
  const fullGoal = signal(false);
  const now = runClock(() => (task()?.runs ?? []).some(activeTaskRun));
  // Once, when the task and its timeline first show: later replies do not pull the reader down.
  let opened = false;
  const end = (node: ViewRef | null) => {
    if (!node || opened) return;
    opened = true;
    setTimeout(() => node.reveal({ vertical: "end", animated: false }), 0);
  };
  // The skeleton, once it appeared, stays its least time before the task (#380).
  const shown = settled(() => !!task());
  return (
    <If
      when={state.gone() || !shown() ? undefined : task()}
      else={
        <TaskDetailMissing
          state={state}
          skeleton={<DetailSkeleton label={uiText("loadingTask")} />}
          onBack={props.onClose}
        />
      }
    >
      {(item) => {
        // What is going on the task: one line per run that has not ended, each its own agent's.
        const lines = () =>
          liveRuns(item()).filter((line) => activeTaskRun(line.run));
        const runName = (entry: TaskRunView) =>
          (entry.agentId === null
            ? state.executor()?.name
            : host.agent(entry.agentId)?.name) ?? uiText("agent");
        const goal = () =>
          fullGoal() || item().description.length <= goalPreview
            ? item().description
            : `${item().description.slice(0, goalPreview)}…`;
        const replies = () =>
          activity().filter((entry) => entry.kind === "comment").length;
        return (
          // Side insets sit on each part, not here: the dependency rows reach both edges so their hover does.
          <View
            style={{
              ...grow,
              paddingBottom: space[12],
              backgroundColor: c().surface,
            }}
          >
            <TaskTopBar
              number={item().number}
              inset={inset}
              onBack={props.onClose}
            >
              <If when={!item().children?.length}>
                <StatusSelect item={item()} state={state} align="end" />
              </If>
              <ActionMenu
                label={uiText("taskActions")}
                triggerStyle={{
                  minWidth: control.sm,
                  width: control.sm,
                  height: control.sm,
                  paddingHorizontal: 0,
                }}
                iconSize={icon.sm}
              >
                <ActionItem
                  label={uiText("edit")}
                  onSelect={() => {
                    state.editTitle.set(item().title);
                    state.editDescription.set(item().description);
                    state.editing.set(true);
                  }}
                />
                <ActionItem
                  label={
                    item().archivedAt ? uiText("unarchive") : uiText("archive")
                  }
                  onSelect={() => {
                    if (item().archivedAt)
                      void host.action(() =>
                        host.optimistic(props.id, { archivedAt: null }, () =>
                          host.call("tasks", "unarchive", {
                            taskId: props.id,
                          }),
                        ),
                      );
                    else state.archive.set(true);
                  }}
                />
              </ActionMenu>
            </TaskTopBar>
            <SmoothScroll style={grow}>
              {/* The panel's section title: body 14 / 600 (compact), not the page's subtitle. */}
              <Label
                variant="body"
                weight={weight.strong}
                style={{
                  paddingTop: space[12],
                  paddingBottom: space[8],
                  paddingHorizontal: inset,
                }}
              >
                {item().title}
              </Label>
              <Edges
                label={uiText("tasksBefore", {
                  count: item().dependsOn?.length ?? 0,
                })}
                edges={item().dependsOn ?? []}
                before
                onTask={props.onTask}
              />
              <Edges
                label={uiText("tasksAfter", {
                  count: item().dependents?.length ?? 0,
                })}
                edges={item().dependents ?? []}
                onTask={props.onTask}
              />
              {/* Spacing as the web's panel: every line of the thread, the description too, starts 35px in. */}
              <View
                style={{
                  ...row,
                  alignItems: "flex-start",
                  gap: space[16],
                  paddingTop: space[8],
                  paddingHorizontal: inset,
                }}
              >
                <AgentFace
                  id={item().createdBy.agentId ?? "user"}
                  size={avatar.sm}
                />
                <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
                  <View style={{ ...row, gap: space[8] }}>
                    <Label variant="small" weight={weight.strong}>
                      {actorLabel(item().createdBy, host.agent)}
                    </Label>
                    <Label variant="caption" tone="muted">
                      {messageTime(item().createdAt, false)}
                    </Label>
                  </View>
                  <View style={{ gap: space[12] }}>
                    <If when={item().description}>
                      <Markdown value={goal()} dense />
                    </If>
                    <If when={item().description.length > goalPreview}>
                      <View
                        role="button"
                        onPress={() => fullGoal.set(!fullGoal())}
                        style={{ cursor: "pointer" }}
                      >
                        <Label variant="caption" tone="muted">
                          {fullGoal()
                            ? uiText("collapseFullText")
                            : uiText("expandFullText")}
                        </Label>
                      </View>
                    </If>
                  </View>
                </View>
              </View>
              <If when={replies()}>
                <View
                  style={{
                    ...row,
                    gap: space[8],
                    paddingTop: space[16],
                    paddingHorizontal: inset,
                  }}
                >
                  <Label variant="caption" tone="muted">
                    {uiText(replies() === 1 ? "oneTaskReply" : "taskReplies", {
                      count: replies(),
                    })}
                  </Label>
                  <View
                    style={{ flex: 1, height: 1, backgroundColor: c().border }}
                  />
                </View>
              </If>
              <View
                style={{ paddingBottom: space[12], paddingHorizontal: inset }}
              >
                <TaskActivity
                  entries={activity()}
                  runs={item().runs}
                  createdBy={item().createdBy}
                  gap={space[16]}
                  onLog={(entry) => log.set(entry)}
                  onTask={props.onTask}
                  onArtifact={props.onArtifact}
                />
              </View>
              {/* A thread opens on its latest reply, next to the box to answer it, as on the web. */}
              <View ref={end} />
            </SmoothScroll>
            <Each of={lines()} key={(line) => line.run.id}>
              {(line) => (
                <View
                  style={{
                    ...row,
                    height: space[24],
                    gap: space[8],
                    flexShrink: 0,
                    paddingHorizontal: inset,
                  }}
                >
                  <StatusDot color={c().blue} />
                  <Label
                    variant="caption"
                    weight={weight.strong}
                    lines={1}
                    style={{ flexShrink: 1 }}
                  >
                    {runDoingText(line().doing, runName(line().run))}
                  </Label>
                  <Label variant="caption" tone="muted" style={{ flex: 1 }}>
                    {runElapsed(line().run, now())}
                  </Label>
                  <View
                    role="button"
                    accessibilityLabel={`${uiText("executionLog")} · ${runName(line().run)}`}
                    onPress={() => log.set(line().run)}
                    style={{ cursor: "pointer" }}
                  >
                    <Label variant="caption" tone="muted">
                      {uiText("executionLog")}
                    </Label>
                  </View>
                  <Button
                    label={uiText("stop")}
                    accessibilityLabel={`${uiText("stop")} · ${runName(line().run)}`}
                    icon="stop"
                    tone="ghost"
                    size={space[20]}
                    iconSize={icon.sm}
                    labelVariant="caption"
                    labelWeight={weight.strong}
                    busy={state.submitting()}
                    style={{ paddingHorizontal: space[4], gap: space[4] }}
                    onPress={() => state.stop(line().run)}
                  />
                </View>
              )}
            </Each>
            <TaskCommentHint
              state={state}
              style={{ paddingHorizontal: inset }}
            />
            <TaskCommentBox state={state} panelInset={inset} />
            <TaskDetailDialogs
              id={props.id}
              layout={props.layout}
              onClose={props.onClose}
              state={state}
            />
          </View>
        );
      }}
    </If>
  );
}

function Edges(props: {
  label: string;
  edges: TaskDependencyView[];
  before?: boolean;
  onTask: (id: string) => void;
}) {
  const c = colors();
  return (
    <If when={props.edges.length}>
      <Label
        variant="small"
        tone="muted"
        style={{
          paddingTop: props.before ? 0 : space[16],
          paddingBottom: space[4],
          paddingHorizontal: inset,
        }}
      >
        {props.label}
      </Label>
      <Each of={props.edges} key={(edge) => edge.taskId}>
        {(edge, index) => (
          <View
            role="button"
            accessibilityLabel={edge().title}
            onPress={() => props.onTask(edge().taskId)}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              height: dependencyRowHeight,
              gap: space[8],
              // Edge to edge, so the hover does too; the text stays where the bordered box put it.
              paddingHorizontal: inset + space[12],
              // One line between two rows: only the first draws the line above the list.
              borderTopWidth: index() === 0 ? 1 : 0,
              borderBottomWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={edge().status} size={icon.sm} />
            <Label
              variant="small"
              weight={weight.strong}
              lines={1}
              style={{ flex: 1 }}
            >
              {edge().title}
            </Label>
            <Label variant="caption" tone="muted">
              {props.before
                ? edge().state === "resolved"
                  ? uiText("dependencyDelivered")
                  : statusName(edge().status)
                : uiText("dependencyWaitsForThis")}
            </Label>
          </View>
        )}
      </Each>
    </If>
  );
}
