import type { BoardTaskDetail } from "@eta/client-contracts";
import type { JSX, TextStyle } from "nsh";
import type { TaskDetailState } from "./task-detail-state";
import { mentionLabel } from "@eta/client-contracts/composer-target";
import { View } from "nsh";
import {
  Button,
  colors,
  Icon,
  inCompact,
  Label,
  row,
  textFaces,
} from "../../components";
import { CheckControl } from "../../components/check-control";
import {
  chatText,
  draft,
  limit,
  mention,
  openDocDraft,
  sendShortcut,
  serialize,
  submitKeys,
} from "../../components/eta-editor";
import { touchScreen } from "../../components/menu";
import { StatusDot } from "../../components/status-dot";
import { densityDefaults } from "../../components/theme";
import { avatar, control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { ActorName } from "./creator";
import { taskMoment } from "./facts";
import { activeTaskRun } from "./run-log";
import { statusName, TaskGlyph } from "./status";
import { StatusSelect } from "./status-select";

/** The width of a rail row's label; what goes under its value starts there. */
const railLabelWidth = 76;

/** A field's label column in the fields list. */
const fieldLabelWidth = 68;

/** The comment box's foot, under the editor, off phones. */
const footHeight = { compact: 32, regular: 36 } as const;

/**
 * The comment box: the chat's text (`chatText`: Markdown as you type, code blocks, long pastes
 * folded) with `@` for the task's agents and a draft kept per task. ⏎ is a new line; ⌘⏎ or the
 * Comment button posts. No files: a task's comment carries text only.
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
  const editor = chatText.createEditor({
    doc: store.doc(),
    plugins: [
      submitKeys({ enter: "newline", onSubmit: () => void submit() }),
      mention({ members, describe: () => uiText("askForAReply") }),
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
  /** The chat's task panel: the box `inset` in from its sides, the hint drawn by the panel. */
  panelInset?: number;
}) {
  const host = useHost();
  const origin = host.address()?.origin;
  const store = openDocDraft(
    `eta.task-comment.v1.${JSON.stringify([origin, props.state.id])}`,
  );
  const c = colors();
  const phone = () => props.state.phone();
  return (
    <If when={store.ready()}>
      {() => (
        <View
          style={
            phone()
              ? {
                  backgroundColor: c().surface,
                  borderTopWidth: 1,
                  borderColor: c().border,
                  paddingHorizontal: space[12],
                  paddingVertical: space[12],
                  gap: space[8],
                }
              : {
                  gap: space[4],
                  marginHorizontal: props.panelInset,
                  flexShrink: 0,
                }
          }
        >
          <CommentBox
            state={props.state}
            origin={origin}
            phone={phone()}
            hint={props.panelInset === undefined || phone()}
          />
        </View>
      )}
    </If>
  );
}

/**
 * The box itself, per Paper's "Task comment": the editor, 1 to 6 lines then it scrolls inside;
 * under it ⌘⏎ (with a keyboard) and a plain Comment button.
 */
function CommentBox(props: {
  state: TaskDetailState;
  origin: string | undefined;
  phone: boolean;
  /** The parent's line over the box (the chat's panel draws its own). */
  hint: boolean;
}) {
  const c = colors();
  const type = textFaces();
  const { editor, submit, disabled, limits } = useCommentEditor(
    props.state,
    props.origin,
  );
  // In the conversation panel (compact): small text, a 32px foot and a 24px button, as the
  // panel's own rows; on a task's page the regular body text, 36 and 28.
  const density = densityDefaults();
  const compact = inCompact();
  const line = () => type(density().editor).prose;
  const pad = space[8];
  return (
    <>
      <If when={props.hint}>
        <TaskCommentHint state={props.state} />
      </If>
      <If when={limits.tooLong()}>
        <Label tone="warning" variant="caption">
          {uiText("composerTooLong")}
        </Label>
      </If>
      <View
        style={{
          borderWidth: 1,
          borderColor: editor.focused() ? c().ink : c().strong,
          backgroundColor: c().canvas,
          flexShrink: 0,
        }}
      >
        <chatText.Editor
          editor={editor}
          label={uiText("comment")}
          placeholder={uiText("commentPlaceholder")}
          minHeight={line() + pad * 2}
          maxHeight={line() * 6 + pad * 2}
          clip
          padding={{ top: pad, bottom: pad, left: space[12], right: space[12] }}
        />
        <View
          style={{
            ...row,
            justifyContent: "flex-end",
            gap: space[8],
            height: props.phone
              ? control.touch
              : compact()
                ? footHeight.compact
                : footHeight.regular,
            paddingLeft: space[12],
            paddingRight: space[4],
          }}
        >
          <If when={!props.phone && !touchScreen}>
            <Label variant="caption" tone="faint">
              {sendShortcut}
            </Label>
          </If>
          <Button
            label={uiText("comment")}
            accessibilityLabel={uiText("sendComment")}
            size={
              props.phone ? control.lg : compact() ? control.sm : control.md
            }
            labelTone={disabled() ? "muted" : "ink"}
            dimDisabled={props.state.posting()}
            disabled={disabled()}
            style={{ paddingHorizontal: props.phone ? space[16] : space[12] }}
            onPress={() => void submit()}
          />
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

export function TaskReviewActions(props: { state: TaskDetailState }) {
  const { executor, phone, review, submitting } = props.state;
  return (
    <View
      style={{
        ...row,
        gap: space[8],
      }}
    >
      <Button
        label={uiText("sendBack")}
        disabled={!executor() || submitting()}
        size={phone() ? control.touch : control.md}
        style={{ flex: phone() ? 1 : undefined }}
        onPress={() => review.set("todo")}
      />
      <Button
        label={uiText("acceptAsDone")}
        size={phone() ? control.touch : control.md}
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
    <View style={{ gap: space[8] }}>
      <View style={{ ...row, gap: space[8], alignItems: "flex-start" }}>
        <Label
          variant="caption"
          tone="muted"
          style={{ width: fieldLabelWidth }}
        >
          {uiText("status")}
        </Label>
        <View style={{ flex: 1, minWidth: 0 }}>
          <StatusSelect item={item()} state={detail.state} />
        </View>
      </View>
      <Each of={fields()} key={(field) => field[0]}>
        {(field) => (
          <View style={{ ...row, alignItems: "flex-start", gap: space[8] }}>
            <Label
              variant="caption"
              tone="muted"
              style={{ width: fieldLabelWidth }}
            >
              {field()[0]}
            </Label>
            <Label variant="small" style={{ flex: 1 }} weight={weight.regular}>
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
    <View style={{ gap: space[12] }}>
      <RailRow label={uiText("status")}>
        <StatusSelect item={item()} state={detail.state} />
      </RailRow>
      <RailRow label={uiText("executor")}>
        <If
          when={executor()}
          else={
            <Label variant="small" weight={weight.strong}>
              {uiText("unassigned")}
            </Label>
          }
        >
          {() => (
            <ActorName
              actor={{ kind: "agent", agentId: executorId() }}
              size={avatar.sm}
            />
          )}
        </If>
      </RailRow>
      <RailRow label={uiText("taskCreator")}>
        <ActorName actor={item().createdBy} size={avatar.sm} />
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
              <Label variant="small" weight={weight.strong}>
                {`#${entry().number} ${entry().title}`}
              </Label>
            </View>
          )}
        </If>
      </RailRow>
      <RailRow label={uiText("workspace")}>
        <Label variant="small" weight={weight.strong} style={{ flex: 1 }}>
          {item().workspace.mode === "worktree"
            ? uiText("taskOwnWorktree")
            : (item().workspace.path ?? uiText("taskProjectDirectory"))}
        </Label>
      </RailRow>
      <RailRow label={uiText("taskRun")}>
        <View style={{ ...row, gap: space[4] }}>
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
                <Icon name="spinner" size={icon.sm} tone="muted" />
              </If>
            )}
          </If>
          <Label variant="caption" weight={weight.strong}>
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
                height: space[20],
                paddingHorizontal: space[4],
                gap: space[4],
                cursor: "pointer",
              }}
            >
              <Icon name="refresh" size={icon.sm} />
              <Label variant="caption" weight={weight.strong}>
                {uiText("rerun")}
              </Label>
            </View>
          </If>
        </View>
      </RailRow>
      <If when={canStartOver()}>
        <View style={{ paddingLeft: railLabelWidth, marginTop: -space[12] }}>
          <Label variant="caption" tone="muted">
            {uiText("startOverHint")}
          </Label>
        </View>
      </If>
      <If when={item().dependsOn?.length}>
        <RailRow label={uiText("taskWaitsForLabel")} top>
          <View style={{ gap: space[4], flex: 1 }}>
            <Each of={item().dependsOn ?? []} key={(edge) => edge.taskId}>
              {(edge) => (
                <View style={{ gap: space[4] }}>
                  <View
                    role="button"
                    accessibilityLabel={edge().title}
                    onPress={() => detail.onTask(edge().taskId)}
                    style={{ ...row, gap: space[4], cursor: "pointer" }}
                  >
                    <TaskGlyph status={edge().status} size={icon.sm} />
                    <Label
                      variant="caption"
                      weight={weight.strong}
                      style={{ flex: 1 }}
                    >
                      {`#${edge().number} ${edge().title}`}
                    </Label>
                  </View>
                  <View
                    style={{ ...row, gap: space[8], paddingLeft: space[16] }}
                  >
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
                      size={icon.sm}
                      disabled={submitting()}
                      style={{ ...row, gap: space[8] }}
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
                      <Icon name="close" size={icon.sm} />
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
              style={{ paddingLeft: space[16], cursor: "pointer" }}
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
          <View style={{ gap: space[4], flex: 1 }}>
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
                  style={{ gap: space[2], cursor: "pointer" }}
                >
                  <View style={{ ...row, gap: space[4] }}>
                    <TaskGlyph status={edge().status} size={icon.sm} />
                    <Label variant="caption" weight={weight.strong}>
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
        <Label variant="small" weight={weight.strong}>
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
      <Label variant="caption" tone="muted" style={{ width: railLabelWidth }}>
        {props.label}
      </Label>
      {props.children}
    </View>
  );
}
