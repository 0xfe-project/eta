import type { TaskDependencyView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { TASK_STATUSES } from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  colors,
  Empty,
  Field,
  grow,
  Icon,
  Label,
  Markdown,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity, taskActivityLabel } from "../tasks/activity";
import { activeTaskRun } from "../tasks/run-log";
import { fills, statusName, TaskGlyph, tones } from "../tasks/status";
import { TaskDetailDialogs } from "../tasks/task-detail-dialogs";
import { createTaskDetailState } from "../tasks/task-detail-state";
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
  const host = useHost();
  const state = createTaskDetailState({ ...props, docked: true });
  const { task, activity, change, canComment, comment, post, posting, log } =
    state;
  const fullGoal = signal(false);
  const updates = signal(false);
  return (
    <If when={task()} else={<Empty title={uiText("loadingTask")} />}>
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
        const latest = () => activity().at(-1);
        return (
          <View style={{ ...grow, padding: 10, backgroundColor: c().canvas }}>
            <View style={{ ...row, height: 26, gap: 8, flexShrink: 0 }}>
              <View
                role="button"
                accessibilityLabel={uiText("backToTasks")}
                onPress={props.onClose}
                style={{ cursor: "pointer" }}
              >
                <Label size={11} line={16}>
                  {`← ${uiText("tasks2")}`}
                </Label>
              </View>
              <Label size={11} line={16} tone="muted" style={{ flex: 1 }}>
                {`#${item().number}`}
              </Label>
              <If when={!item().children?.length}>
                <ActionMenu
                  label={uiText("changeStatus")}
                  triggerStyle={{
                    height: 28,
                    minWidth: 128,
                    paddingHorizontal: 8,
                    gap: 6,
                    borderWidth: 1,
                    borderColor: c()[tones[item().status]],
                    backgroundColor: c()[fills[item().status]],
                    justifyContent: "flex-start",
                  }}
                  value={statusName(item().status)}
                >
                  <Each of={TASK_STATUSES}>
                    {(entry) => (
                      <ActionItem
                        label={statusName(entry())}
                        checked={item().status === entry()}
                        onSelect={() => change(entry())}
                      />
                    )}
                  </Each>
                </ActionMenu>
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
                size={16}
                line={24}
                weight={700}
                style={{ paddingTop: 12, paddingBottom: 14 }}
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
              <View
                style={{
                  ...row,
                  alignItems: "flex-start",
                  gap: 10,
                  paddingTop: 12,
                }}
              >
                <AgentFace id={author()?.id ?? "user"} size={20} />
                <View style={{ flex: 1, minWidth: 0, gap: 14 }}>
                  <View style={{ ...row, gap: 8 }}>
                    <Label size={12} line={16} weight={600}>
                      {author()?.name ?? uiText("you")}
                    </Label>
                    <Label size={10} line={14} tone="muted">
                      {messageTime(item().createdAt, false)}
                    </Label>
                  </View>
                  <View style={{ paddingLeft: 10, gap: 12 }}>
                    <If when={item().description}>
                      <Markdown value={goal()} dense />
                    </If>
                    <If when={item().description.length > goalPreview}>
                      <View
                        role="button"
                        onPress={() => fullGoal.set(!fullGoal())}
                        style={{ cursor: "pointer" }}
                      >
                        <Label size={10} line={14} tone="muted">
                          {fullGoal()
                            ? uiText("collapseFullText")
                            : uiText("expandFullText")}
                        </Label>
                      </View>
                    </If>
                    <If when={activity().length}>
                      <If when={updates() ? undefined : latest()}>
                        {(entry) => (
                          <View style={{ gap: 2 }}>
                            <Label size={11} line={16} tone="muted">
                              {`${
                                host.agent(entry().actor.agentId)?.name ??
                                uiText(
                                  entry().actor.kind === "user"
                                    ? "you"
                                    : "agent",
                                )
                              } ${taskActivityLabel(entry())}`}
                            </Label>
                            <Label size={10} line={14} tone="mutedInk">
                              {messageTime(entry().createdAt, false)}
                            </Label>
                          </View>
                        )}
                      </If>
                      <View
                        role="button"
                        accessibilityState={{ expanded: updates() }}
                        onPress={() => updates.set(!updates())}
                        style={{ ...row, gap: 4, cursor: "pointer" }}
                      >
                        <Icon
                          name={updates() ? "down" : "right"}
                          size={10}
                          tone="muted"
                        />
                        <Label size={11} line={16} tone="muted">
                          {uiText(
                            activity().length === 1
                              ? "oneTaskUpdate"
                              : "taskUpdates",
                            { count: activity().length },
                          )}
                        </Label>
                      </View>
                      <If when={updates()}>
                        <TaskActivity entries={activity()} phone={false} />
                      </If>
                    </If>
                  </View>
                </View>
              </View>
            </Scroll>
            <If when={run()}>
              {(entry) => (
                <View style={{ ...row, height: 24, gap: 8, flexShrink: 0 }}>
                  <StatusDot color={c().blue} />
                  <Label size={10} line={14} weight={600} style={{ flex: 1 }}>
                    {uiText("agentIsWorking", {
                      name: state.executor()?.name ?? uiText("agent"),
                    })}
                  </Label>
                  <View
                    role="button"
                    onPress={() => log.set(entry())}
                    style={{ cursor: "pointer" }}
                  >
                    <Label size={10} line={14} tone="muted">
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
                    <Label size={10} line={14} weight={600}>
                      {uiText("stop")}
                    </Label>
                  </View>
                </View>
              )}
            </If>
            <If when={canComment(item())}>
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
                    fontSize: 12,
                    lineHeight: 16,
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
            </If>
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
        size={11}
        line={16}
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
            <Label
              size={11}
              line={16}
              weight={600}
              lines={1}
              style={{ flex: 1 }}
            >
              {edge().title}
            </Label>
            <Label size={10} line={14} tone="muted">
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
