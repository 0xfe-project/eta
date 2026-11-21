import type { BoardTaskDetail } from "@eta/client-contracts";
import type { JSX, TextStyle } from "nsh";
import type { TaskDetailState } from "./task-detail-state";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { View } from "nsh";
import { Button, colors, Icon, Label, row, textFaces } from "../../components";
import { CheckControl } from "../../components/check-control";
import {
  createEtaEditor,
  draft,
  EtaEditor,
  limit,
  mention,
  openDocDraft,
  pasteBlock,
  plainText,
  serialize,
  submitKeys,
} from "../../components/eta-editor";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { ActorName } from "./creator";
import { taskMoment } from "./facts";
import { activeTaskRun } from "./run-log";
import { statusName, TaskGlyph } from "./status";
import { StatusSelect } from "./status-select";

/**
 * The comment box: the same editor as the chat's (`EtaEditor`), with `@` for the task's agents,
 * long pastes folded and a draft kept per task. No files: a task's comment carries text only.
 */
function useCommentEditor(state: TaskDetailState, origin: string | undefined) {
  const host = useHost();
  const { post, posting, task } = state;
  const store = openDocDraft(
    `eta.task-comment.v1.${JSON.stringify([origin, state.id])}`,
  );
  const limits = limit();
  const out = serialize();
  // The task's own agents first (its executor, who ran in it, who spoke on it), then the others.
  const members = () => {
    const item = task();
    const own = new Set<string>();
    if (item?.assigneeAgentId) own.add(item.assigneeAgentId);
    for (const run of item?.runs ?? []) if (run.agentId) own.add(run.agentId);
    for (const entry of state.activity())
      if (entry.actor.agentId) own.add(entry.actor.agentId);
    const agents = host.agents();
    const ordered = [
      ...agents.filter((agent) => own.has(agent.id)),
      ...agents.filter((agent) => !own.has(agent.id)),
    ].map((agent) => ({ id: agent.id, name: agent.name, busy: false }));
    return ordered.map((member) => ({
      ...member,
      name: mentionLabel(member, ordered),
    }));
  };
  const editor = createEtaEditor({
    doc: store.doc(),
    plugins: [
      plainText(),
      submitKeys({ onSubmit: () => void submit() }),
      mention({ members, describe: () => uiText("askForAReply") }),
      pasteBlock(),
      draft({ save: store.save }),
      limits,
      out,
    ],
  });
  async function submit() {
    if (posting() || limits.tooLong() || out.state().blank) return;
    const sent = out.read();
    if (await post(sent.text, sent.mentions)) editor.clear();
  }
  const disabled = () => posting() || out.state().blank || limits.tooLong();
  return { editor, submit, disabled, limits };
}

export function TaskCommentBox(props: {
  state: TaskDetailState;
  /** Tablet's box: 36 high, the send mark bare at its end. */
  tablet?: boolean;
  /** The chat's task panel: a 38-high box `inset` in from its sides, the hint drawn by the panel. */
  panelInset?: number;
}) {
  const host = useHost();
  const origin = host.address()?.origin;
  const store = openDocDraft(
    `eta.task-comment.v1.${JSON.stringify([origin, props.state.id])}`,
  );
  return (
    <If when={store.ready()}>
      {() => (
        <If
          when={!props.state.phone()}
          else={<PhoneCommentBox state={props.state} origin={origin} />}
        >
          <DesktopCommentBox
            state={props.state}
            origin={origin}
            tablet={props.tablet}
            panelInset={props.panelInset}
          />
        </If>
      )}
    </If>
  );
}

function DesktopCommentBox(props: {
  state: TaskDetailState;
  origin: string | undefined;
  tablet?: boolean;
  panelInset?: number;
}) {
  const panel = () => props.panelInset !== undefined;
  const c = colors();
  const type = textFaces();
  const { editor, submit, disabled, limits } = useCommentEditor(
    props.state,
    props.origin,
  );
  const line = () => type("small").prose;
  const height = () => (panel() ? 36 : props.tablet ? 34 : 35);
  const bare = () => props.tablet || panel();
  return (
    <>
      <If when={!panel()}>
        <TaskCommentHint state={props.state} />
      </If>
      <If when={limits.tooLong()}>
        <Label tone="amber" variant="caption">
          {uiText("composerTooLong")}
        </Label>
      </If>
      <View
        style={{
          ...row,
          alignItems: "flex-end",
          gap: 6,
          borderWidth: 1,
          borderColor: panel() ? c().border : c().strong,
          minHeight: height() + 2,
          flexShrink: 0,
          marginHorizontal: props.panelInset,
          paddingLeft: panel() || props.tablet ? 10 : 9,
          paddingRight: bare() ? 10 : 4,
        }}
      >
        <EtaEditor
          editor={editor}
          label={uiText("comment")}
          placeholder={uiText("replyARunningTaskReadsIt")}
          variant="small"
          minHeight={height()}
          maxHeight={160}
          padding={{
            top: (height() - line()) / 2,
            bottom: (height() - line()) / 2,
            left: 0,
            right: 0,
          }}
          style={{ flex: 1 }}
        />
        <View style={{ height: height(), justifyContent: "center" }}>
          <If
            when={!bare()}
            else={
              <View
                role="button"
                accessibilityLabel={uiText("sendComment")}
                accessibilityState={{ disabled: disabled() }}
                onPress={() => void submit()}
                style={{ cursor: "pointer", opacity: disabled() ? 0.45 : 1 }}
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
              disabled={disabled()}
              onPress={() => void submit()}
            />
          </If>
        </View>
      </View>
    </>
  );
}

/** What a comment does where it is not obvious: over a parent's box, that it starts no run. */
export function TaskCommentHint(props: {
  state: TaskDetailState;
  style?: TextStyle;
}) {
  const { parentHint, task } = props.state;
  return (
    <If when={task() && parentHint(task()!)}>
      <Label variant="caption" tone="muted" style={props.style}>
        {uiText("parentCommentHint")}
      </Label>
    </If>
  );
}

/** The phone's reply box under the task: a borderless editor, then Send on its own row. */
function PhoneCommentBox(props: {
  state: TaskDetailState;
  origin: string | undefined;
}) {
  const c = colors();
  const { editor, submit, disabled, limits } = useCommentEditor(
    props.state,
    props.origin,
  );
  return (
    <View
      style={{
        backgroundColor: c().surface,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <TaskCommentHint
        state={props.state}
        style={{ paddingTop: 10, paddingHorizontal: 16 }}
      />
      <If when={limits.tooLong()}>
        <Label
          tone="amber"
          variant="caption"
          style={{ paddingTop: 10, paddingHorizontal: 16 }}
        >
          {uiText("composerTooLong")}
        </Label>
      </If>
      <EtaEditor
        editor={editor}
        label={uiText("comment")}
        placeholder={uiText("replyARunningTaskReadsIt")}
        minHeight={48}
        maxHeight={180}
        padding={{ top: 13, bottom: 13, left: 16, right: 16 }}
      />
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
          disabled={disabled()}
          dimDisabled={props.state.posting()}
          onPress={() => void submit()}
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
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("todo")}
      />
      <Button
        label={uiText("acceptAsDone")}
        size={phone() ? 40 : 26}
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
  const { phone } = detail.state;
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
        <Label variant="caption" tone="muted" style={{ width: 68 }}>
          {uiText("status")}
        </Label>
        <View style={{ flex: 1, minWidth: 0 }}>
          <StatusSelect item={item()} state={detail.state} />
        </View>
      </View>
      <Each of={fields()} key={(field) => field[0]}>
        {(field) => (
          <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
            <Label variant="caption" tone="muted" style={{ width: 68 }}>
              {field()[0]}
            </Label>
            <Label variant="small" style={{ flex: 1 }} weight={500}>
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

/** The desktop page's right rail: every property of the task, one row each. */
export function TaskRail(detail: {
  item: BoardTaskDetail;
  state: TaskDetailState;
  onTask: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const { replacing, search, submitting } = detail.state;
  const item = () => detail.item;
  const executorId = () => item().assigneeAgentId ?? item().createdBy.agentId;
  const executor = () => host.agent(executorId());
  const parent = () => item().ancestors?.at(-1);
  const run = () => item().runs.at(-1);
  const runText = () => taskRunText(item());
  /** A stopped or finished run starts over from the rail; a running one has Stop instead. */
  const canStartOver = () =>
    !item().children?.length && !!run() && !activeTaskRun(run()!);
  function mutate(work: () => Promise<unknown>) {
    void detail.state.mutate(async () => {
      await work();
    });
  }
  return (
    <View style={{ gap: 14 }}>
      <RailRow label={uiText("status")}>
        <StatusSelect item={item()} state={detail.state} />
      </RailRow>
      <RailRow label={uiText("executor")}>
        <If
          when={executor()}
          else={
            <Label variant="small" weight={600}>
              {uiText("unassigned")}
            </Label>
          }
        >
          {() => (
            <ActorName
              actor={{ kind: "agent", agentId: executorId() }}
              size={16}
            />
          )}
        </If>
      </RailRow>
      <RailRow label={uiText("taskCreator")}>
        <ActorName actor={item().createdBy} size={16} />
      </RailRow>
      <RailRow label={uiText("taskBelongsTo")}>
        <If
          when={parent()}
          else={
            <Label variant="caption" tone="muted">
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
              <Label variant="small" weight={600}>
                {`#${entry().number} ${entry().title}`}
              </Label>
            </View>
          )}
        </If>
      </RailRow>
      <RailRow label={uiText("workspace")}>
        <Label variant="small" weight={600} style={{ flex: 1 }}>
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
          <Label variant="caption" weight={600}>
            {runText()}
          </Label>
          <If when={canStartOver()}>
            <View
              role="button"
              accessibilityLabel={uiText("rerun")}
              onPress={() =>
                mutate(() => host.call("tasks", "rerun", { taskId: item().id }))
              }
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                height: 20,
                paddingHorizontal: 4,
                gap: 4,
                cursor: "pointer",
              }}
            >
              <Icon name="refresh" size={11} />
              <Label variant="caption" weight={600}>
                {uiText("rerun")}
              </Label>
            </View>
          </If>
        </View>
      </RailRow>
      <If when={canStartOver()}>
        <View style={{ paddingLeft: 76, marginTop: -10 }}>
          <Label variant="caption" tone="muted">
            {uiText("startOverHint")}
          </Label>
        </View>
      </If>
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
                    <Label variant="caption" weight={600} style={{ flex: 1 }}>
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                  <View style={{ ...row, gap: 8, paddingLeft: 17 }}>
                    <Label variant="caption" tone="muted">
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
                      <Label variant="caption" tone="muted">
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
              <Label variant="caption" tone="muted">
                {uiText("editPrerequisites")}
              </Label>
            </View>
          </View>
        </RailRow>
      </If>
      <If when={item().dependents?.length}>
        <RailRow label={uiText("waitedOnBy")} top>
          <View style={{ gap: 6, flex: 1 }}>
            <Label variant="caption" tone="muted">
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
                    <Label variant="caption" weight={600}>
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                  <Label variant="caption" tone="muted">
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
        <Label variant="small" weight={600}>
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
      <Label variant="caption" tone="muted" style={{ width: 76 }}>
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}
