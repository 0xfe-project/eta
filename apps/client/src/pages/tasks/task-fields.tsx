import type { BoardTaskDetail } from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, Field, Icon, Label, row } from "../../components";
import { CheckControl } from "../../components/check-control";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { taskMoment } from "./facts";
import { activeTaskRun } from "./run-log";
import { statusName, TaskGlyph, TaskStatus, tones } from "./status";

export function TaskCommentBox(props: {
  state: TaskDetailState;
  /** Tablet's box: 36 high, the send mark bare at its end. */
  tablet?: boolean;
}) {
  const c = colors();
  const { comment, phone, post, posting, updateComment } = props.state;
  return (
    <If when={!phone()} else={<PhoneCommentBox state={props.state} />}>
      <View
        style={{
          ...row,
          gap: 6,
          borderWidth: 1,
          borderColor: c().strong,
          height: props.tablet ? 36 : 37,
          paddingLeft: props.tablet ? 10 : 9,
          paddingRight: props.tablet ? 10 : 4,
        }}
      >
        <Field
          label={uiText("comment")}
          placeholder={uiText("replyARunningTaskReadsIt")}
          value={comment()}
          onChange={updateComment}
          onSubmit={() => void post()}
          style={{
            flex: 1,
            borderWidth: 0,
            height: props.tablet ? 34 : 35,
            paddingHorizontal: 0,
            paddingVertical: 0,
            fontSize: 12,
            lineHeight: 16,
          }}
        />
        <If
          when={!props.tablet}
          else={
            <View
              role="button"
              accessibilityLabel={uiText("sendComment")}
              accessibilityState={{ disabled: posting() || !comment().trim() }}
              onPress={() => {
                if (!posting() && comment().trim()) void post();
              }}
              style={{ cursor: "pointer" }}
            >
              <Icon name="send" size={14} tone="muted" />
            </View>
          }
        >
          <Button
            label={uiText("sendComment")}
            icon="send"
            iconOnly
            iconSize={14}
            labelTone="muted"
            tone="ghost"
            size={28}
            disabled={posting() || !comment().trim()}
            onPress={() => void post()}
          />
        </If>
      </View>
    </If>
  );
}

/** The phone's reply box under the task: a borderless field, then Send on its own row. */
function PhoneCommentBox(props: { state: TaskDetailState }) {
  const c = colors();
  const { comment, post, posting, updateComment } = props.state;
  return (
    <View
      style={{
        backgroundColor: c().surface,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, height: 48, paddingHorizontal: 16 }}>
        <Field
          label={uiText("comment")}
          placeholder={uiText("replyARunningTaskReadsIt")}
          value={comment()}
          onChange={updateComment}
          onSubmit={() => void post()}
          style={{
            flex: 1,
            borderWidth: 0,
            paddingHorizontal: 0,
            paddingVertical: 0,
            backgroundColor: c().surface,
            fontSize: 14,
            lineHeight: 20,
          }}
        />
      </View>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          height: 48,
          paddingLeft: 16,
          paddingRight: 12,
          gap: 8,
        }}
      >
        <Button
          label={uiText("send")}
          tone="primary"
          size={32}
          style={{ paddingHorizontal: 14 }}
          disabled={posting() || !comment().trim()}
          dimDisabled={posting()}
          onPress={() => void post()}
        />
      </View>
    </View>
  );
}

export function TaskReviewActions(props: { state: TaskDetailState }) {
  const { executor, phone, review, submitting } = props.state;
  return (
    <View
      style={{
        ...row,
        gap: 8,
      }}
    >
      <Button
        label={uiText("sendBack")}
        disabled={!executor() || submitting()}
        size={phone() ? 40 : 26}
        labelSize={phone() ? 13 : undefined}
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("todo")}
      />
      <Button
        label={uiText("acceptAsDone")}
        size={phone() ? 40 : 26}
        labelSize={phone() ? 13 : undefined}
        tone="primary"
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("done")}
      />
    </View>
  );
}

export function TaskFields(detail: {
  item: BoardTaskDetail;
  state: TaskDetailState;
}) {
  const host = useHost();
  const { change, phone, status } = detail.state;
  const item = () => detail.item;
  const executor = () =>
    host.agent(item().assigneeAgentId ?? item().createdBy.agentId);
  const fields = () =>
    [
      ["Executor", executor()?.name ?? "Unassigned"],
      [
        "Belongs to",
        item().ancestors?.at(-1)
          ? `#${item().ancestors!.at(-1)!.number} ${
              item().ancestors!.at(-1)!.title
            }`
          : "",
      ],
      [
        "Workspace",
        item().workspace.mode === "worktree"
          ? "Own git worktree"
          : (item().workspace.path ?? "Project directory"),
      ],
      ["Run", item().runs.at(-1)?.status ?? ""],
      ["Updated", relativeTime(item().updatedAt)],
    ].filter(([, value]) => value);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ ...row, gap: 8, alignItems: "flex-start" }}>
        <Label size={11} tone="muted" style={{ width: 68 }}>
          {uiText("status")}
        </Label>
        <View style={{ gap: 4, flex: 1 }}>
          <View
            role="button"
            accessibilityLabel={uiText("changeStatus")}
            onPress={() => status.set(!status())}
            style={{ ...row, gap: 6, cursor: "pointer" }}
          >
            <TaskStatus task={item()} />
            <Icon name="down" size={9} tone="muted" />
          </View>
          <If when={status()}>
            <View style={{ gap: 4 }}>
              <Each of={TASK_STATUSES}>
                {(entry) => (
                  <Button
                    label={statusName(entry())}
                    selected={entry() === item().status}
                    onPress={() => change(entry())}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </View>
      <Each of={fields()} key={(field) => field[0]}>
        {(field) => (
          <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
            <Label size={11} tone="muted" style={{ width: 68 }}>
              {field()[0]}
            </Label>
            <Label size={12} style={{ flex: 1 }} weight={500}>
              {field()[1]}
            </Label>
          </View>
        )}
      </Each>
      <If
        when={
          item().status === "in_review" && !item().children?.length && !phone()
        }
      >
        <TaskReviewActions state={detail.state} />
      </If>
    </View>
  );
}

/** Where the task's latest run stands, in a word or two. */
export function taskRunText(item: BoardTaskDetail) {
  const last = item.runs.at(-1);
  if (!last) return uiText("taskNeverRun");
  if (activeTaskRun(last)) return uiText("running");
  if (last.status === "completed" && last.startedAt && last.finishedAt)
    return uiText("taskRunCompleted", {
      time: uiText("taskMinutes", {
        count: Math.max(
          1,
          Math.round((last.finishedAt - last.startedAt) / 60_000),
        ),
      }),
    });
  return uiText(
    last.status === "completed" ? "taskCompleted" : "taskRunStopped",
  );
}

export const statusFill = {
  in_progress: "blueFill",
  in_review: "amberFill",
  done: "greenFill",
} as const;

/** The desktop page's right rail: every property of the task, one row each. */
export function TaskRail(detail: {
  item: BoardTaskDetail;
  state: TaskDetailState;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const { change, replacing, search, status, submitting } = detail.state;
  const item = () => detail.item;
  const executor = () =>
    host.agent(item().assigneeAgentId ?? item().createdBy.agentId);
  const parent = () => item().ancestors?.at(-1);
  const run = () => item().runs.at(-1);
  const tint = () =>
    statusFill[item().status as keyof typeof statusFill] as
      | (typeof statusFill)[keyof typeof statusFill]
      | undefined;
  const runText = () => taskRunText(item());
  function mutate(work: () => Promise<unknown>) {
    void detail.state.mutate(async () => {
      await work();
    });
  }
  return (
    <View style={{ gap: 14 }}>
      <RailRow label={uiText("status")}>
        <View style={{ gap: 4, flex: 1 }}>
          <View
            role="button"
            accessibilityLabel={uiText("changeStatus")}
            onPress={() => status.set(!status())}
            style={{
              ...row,
              alignSelf: "flex-start",
              height: 28,
              minWidth: 128,
              paddingHorizontal: 8,
              gap: 6,
              borderWidth: 1,
              borderColor: tint() ? c()[tones[item().status]] : c().strong,
              backgroundColor: tint() ? c()[tint()!] : c().canvas,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={item().status} size={14} />
            <Label
              size={12}
              line={16}
              tone={tint() ? tones[item().status] : "ink"}
              style={{ flex: 1 }}
            >
              {statusName(item().status)}
            </Label>
            <Icon
              name="down"
              size={10}
              tone={tint() ? tones[item().status] : "ink"}
            />
          </View>
          <If when={status()}>
            <View style={{ gap: 4 }}>
              <Each of={TASK_STATUSES}>
                {(entry) => (
                  <Button
                    label={statusName(entry())}
                    selected={entry() === item().status}
                    onPress={() => change(entry())}
                  />
                )}
              </Each>
            </View>
          </If>
        </View>
      </RailRow>
      <RailRow label={uiText("executor")}>
        <Label size={12} line={16} weight={600}>
          {executor()?.name ?? uiText("unassigned")}
        </Label>
      </RailRow>
      <RailRow label={uiText("taskBelongsTo")}>
        <If
          when={parent()}
          else={
            <Label size={10} line={12} tone="muted">
              {uiText("pickAPieceOfWork")}
            </Label>
          }
        >
          {(entry) => (
            <View
              role="button"
              accessibilityLabel={entry().title}
              onPress={() => detail.onTask(entry().taskId)}
              style={{ cursor: "pointer", flex: 1 }}
            >
              <Label size={12} line={16} weight={600}>
                {`#${entry().number} ${entry().title}`}
              </Label>
            </View>
          )}
        </If>
      </RailRow>
      <RailRow label={uiText("workspace")}>
        <Label size={12} line={16} weight={600} style={{ flex: 1 }}>
          {item().workspace.mode === "worktree"
            ? uiText("taskOwnWorktree")
            : (item().workspace.path ?? uiText("taskProjectDirectory"))}
        </Label>
      </RailRow>
      <RailRow label={uiText("taskRun")}>
        <View style={{ ...row, gap: 6 }}>
          <If when={run()}>
            {(last) => (
              <If
                when={activeTaskRun(last())}
                else={
                  <StatusDot
                    color={
                      last().status === "completed" ? c().green : c().muted
                    }
                  />
                }
              >
                <Icon name="spinner" size={10} tone="muted" />
              </If>
            )}
          </If>
          <Label size={10} line={12} weight={600}>
            {runText()}
          </Label>
        </View>
      </RailRow>
      <If when={item().dependsOn?.length}>
        <RailRow label={uiText("taskWaitsForLabel")} top>
          <View style={{ gap: 6, flex: 1 }}>
            <Each of={item().dependsOn ?? []} key={(edge) => edge.taskId}>
              {(edge) => (
                <View style={{ gap: 6 }}>
                  <View
                    role="button"
                    accessibilityLabel={edge().title}
                    onPress={() => detail.onTask(edge().taskId)}
                    style={{ ...row, gap: 5, cursor: "pointer" }}
                  >
                    <TaskGlyph status={edge().status} size={12} />
                    <Label size={10} line={12} weight={600} style={{ flex: 1 }}>
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                  <View style={{ ...row, gap: 8, paddingLeft: 17 }}>
                    <Label size={10} line={12} tone="muted">
                      {edge().state === "resolved"
                        ? uiText("taskReady")
                        : edge().state === "cancelled"
                          ? statusName("cancelled")
                          : uiText("taskWaitingState")}
                    </Label>
                    <CheckControl
                      label={uiText("mustBeDone")}
                      checked={edge().requireDone}
                      size={11}
                      disabled={submitting()}
                      style={{ ...row, gap: 8 }}
                      onChange={(checked) =>
                        mutate(() =>
                          host.call("tasks", "addDependency", {
                            taskId: item().id,
                            dependsOn: edge().taskId,
                            requireDone: checked,
                          }),
                        )
                      }
                    >
                      <Label size={10} line={12} tone="muted">
                        {uiText("mustBeDone")}
                      </Label>
                    </CheckControl>
                    <View
                      role="button"
                      accessibilityLabel={uiText("removePrerequisite", {
                        number: edge().number,
                      })}
                      onPress={() =>
                        mutate(() =>
                          host.call("tasks", "removeDependency", {
                            taskId: item().id,
                            dependsOn: edge().taskId,
                          }),
                        )
                      }
                      style={{ cursor: "pointer" }}
                    >
                      <Icon name="close" size={10} />
                    </View>
                  </View>
                </View>
              )}
            </Each>
            <View
              role="button"
              accessibilityLabel={uiText("editPrerequisites")}
              onPress={() => {
                search.set("");
                replacing.set(true);
              }}
              style={{ paddingLeft: 17, cursor: "pointer" }}
            >
              <Label size={10} line={12} tone="muted">
                {uiText("editPrerequisites")}
              </Label>
            </View>
          </View>
        </RailRow>
      </If>
      <If when={item().dependents?.length}>
        <RailRow label={uiText("waitedOnBy")} top>
          <View style={{ gap: 6, flex: 1 }}>
            <Label size={10} line={12} tone="muted">
              {item().dependents!.length === 1
                ? uiText("oneTaskWaitsForIt")
                : uiText("taskDependentCount", {
                    count: item().dependents!.length,
                  })}
            </Label>
            <Each of={item().dependents ?? []} key={(edge) => edge.taskId}>
              {(edge) => (
                <View
                  role="button"
                  accessibilityLabel={edge().title}
                  onPress={() => detail.onTask(edge().taskId)}
                  style={{ gap: 2, cursor: "pointer" }}
                >
                  <View style={{ ...row, gap: 5 }}>
                    <TaskGlyph status={edge().status} size={12} />
                    <Label size={10} line={12} weight={600}>
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                  <Label size={10} line={12} tone="muted">
                    {edge().status === "todo"
                      ? uiText("taskWaitingState")
                      : statusName(edge().status)}
                  </Label>
                </View>
              )}
            </Each>
          </View>
        </RailRow>
      </If>
      <RailRow label={uiText("taskUpdated")}>
        <Label size={12} line={16} weight={600}>
          {taskMoment(item().updatedAt)}
        </Label>
      </RailRow>
      <If when={item().status === "in_review" && !item().children?.length}>
        <TaskReviewActions state={detail.state} />
      </If>
    </View>
  );
}

function RailRow(props: {
  label: string;
  top?: boolean;
  children: JSX.Element;
}) {
  return (
    <View style={{ ...row, alignItems: props.top ? "flex-start" : "center" }}>
      <Label size={10} line={12} tone="muted" style={{ width: 76 }}>
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}
