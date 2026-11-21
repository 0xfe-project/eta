import type { TaskDependencyView } from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  DetailSkeleton,
  Field,
  grow,
  Icon,
  Label,
  Markdown,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity } from "../tasks/activity";
import { activeTaskRun } from "../tasks/run-log";
import { statusName, TaskGlyph } from "../tasks/status";
import { StatusSelect } from "../tasks/status-select";
import { TaskDetailDialogs } from "../tasks/task-detail-dialogs";
import { createTaskDetailState } from "../tasks/task-detail-state";
import { TaskCommentHint } from "../tasks/task-fields";
import { messageTime } from "./message-time";

/** How long a goal shows before "Expand full text". */
const goalPreview = 600;

/** A task opened in the conversation panel: under its tabs, compact. */
export function PanelTask(props: {
  id: string;
  layout: Layout;
  onClose: () => void;
  onTask: (id: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  const host = useHost();
  const state = createTaskDetailState({ ...props, docked: true });
  const { task, activity, comment, post, posting, log } = state;
  const fullGoal = signal(false);
  // Once, when the task and its timeline first show: later replies do not pull the reader down.
  let opened = false;
  const end = (node: ViewRef | null) => {
    if (!node || opened) return;
    opened = true;
    setTimeout(() => node.reveal({ vertical: "end", animated: false }), 0);
  };
  return (
    <If when={task()} else={<DetailSkeleton label={uiText("loadingTask")} />}>
      {(item) => {
        const run = () => {
          const last = item().runs.at(-1);
          return last && activeTaskRun(last) ? last : undefined;
        };
        const author = () =>
          item().createdBy.kind === "agent"
            ? host.agent(item().createdBy.agentId)
            : undefined;
        const goal = () =>
          fullGoal() || item().description.length <= goalPreview
            ? item().description
            : `${item().description.slice(0, goalPreview)}…`;
        const replies = () =>
          activity().filter((entry) => entry.kind === "comment").length;
        return (
          <View style={{ ...grow, padding: 11, backgroundColor: c().canvas }}>
            <View style={{ ...row, height: 26, gap: 8, flexShrink: 0 }}>
              <View
                role="button"
                accessibilityLabel={uiText("backToTasks")}
                onPress={props.onClose}
                style={{ cursor: "pointer" }}
              >
                <Label variant="small">{`← ${uiText("tasks2")}`}</Label>
              </View>
              <Label variant="small" tone="muted" style={{ flex: 1 }}>
                {`#${item().number}`}
              </Label>
              <If when={!item().children?.length}>
                <StatusSelect item={item()} state={state} align="end" />
              </If>
              <ActionMenu
                label={uiText("taskActions")}
                triggerStyle={{ minWidth: 14, paddingHorizontal: 0 }}
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
                        host.call("tasks", "unarchive", { taskId: props.id }),
                      );
                    else state.archive.set(true);
                  }}
                />
              </ActionMenu>
            </View>
            <Scroll style={grow} scrollbar={false}>
              <Label
                variant="subtitle"
                weight={700}
                style={{ paddingTop: 4, paddingBottom: 7 }}
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
                  gap: 15,
                  paddingTop: 7,
                }}
              >
                <AgentFace id={author()?.id ?? "user"} size={20} />
                <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                  <View style={{ ...row, gap: 8 }}>
                    <Label variant="small" weight={600}>
                      {author()?.name ?? uiText("you")}
                    </Label>
                    <Label variant="caption" tone="muted">
                      {messageTime(item().createdAt, false)}
                    </Label>
                  </View>
                  <View style={{ gap: 12 }}>
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
                <View style={{ ...row, gap: 8, paddingTop: 14 }}>
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
              <View style={{ paddingBottom: 11 }}>
                <TaskActivity
                  entries={activity()}
                  runs={item().runs}
                  createdBy={item().createdBy}
                  gap={15}
                  onLog={(entry) => log.set(entry)}
                />
              </View>
              {/* A thread opens on its latest reply, next to the box to answer it, as on the web. */}
              <View ref={end} />
            </Scroll>
            <If when={run()}>
              {(entry) => (
                <View style={{ ...row, height: 24, gap: 8, flexShrink: 0 }}>
                  <StatusDot color={c().blue} />
                  <Label variant="caption" weight={600} style={{ flex: 1 }}>
                    {uiText("agentIsWorking", {
                      name: state.executor()?.name ?? uiText("agent"),
                    })}
                  </Label>
                  <View
                    role="button"
                    onPress={() => log.set(entry())}
                    style={{ cursor: "pointer" }}
                  >
                    <Label variant="caption" tone="muted">
                      {uiText("executionLog")}
                    </Label>
                  </View>
                  <View
                    role="button"
                    accessibilityLabel={uiText("stop")}
                    onPress={() => state.stop(entry())}
                    style={{ ...row, gap: 4, cursor: "pointer" }}
                  >
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderWidth: 1.5,
                        borderColor: c().ink,
                      }}
                    />
                    <Label variant="caption" weight={600}>
                      {uiText("stop")}
                    </Label>
                  </View>
                </View>
              )}
            </If>
            <TaskCommentHint state={state} />
            <View
              style={{
                ...row,
                height: 38,
                gap: 8,
                paddingHorizontal: 10,
                flexShrink: 0,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Field
                label={uiText("comment")}
                placeholder={uiText("replyARunningTaskReadsIt")}
                value={comment()}
                onChange={state.updateComment}
                onSubmit={() => void post()}
                style={{
                  flex: 1,
                  height: 36,
                  paddingHorizontal: 0,
                  borderWidth: 0,
                  ...textStyle(type("small")),
                }}
              />
              <View
                role="button"
                accessibilityLabel={uiText("sendComment")}
                onPress={() => void post()}
                style={{
                  opacity: posting() || !comment().trim() ? 0.45 : 1,
                  cursor: "pointer",
                }}
              >
                <Icon name="send" size={14} tone="muted" />
              </View>
            </View>
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
        style={{ paddingTop: props.before ? 0 : 14, paddingBottom: 4 }}
      >
        {props.label}
      </Label>
      <Each of={props.edges} key={(edge) => edge.taskId}>
        {(edge) => (
          <View
            role="button"
            accessibilityLabel={edge().title}
            onPress={() => props.onTask(edge().taskId)}
            hoverStyle={{ backgroundColor: c().selected }}
            style={{
              ...row,
              height: 30,
              gap: 8,
              paddingHorizontal: 10,
              borderWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={edge().status} size={12} />
            <Label variant="small" weight={600} lines={1} style={{ flex: 1 }}>
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
