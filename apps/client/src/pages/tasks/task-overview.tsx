import type {
  BoardTaskDetail,
  TaskDependencyView,
  TaskRunView,
} from "@eta/client-contracts";
import type { Layout, TextVariant } from "../../components";
import type { TaskDetailState } from "./task-detail-state";
import { untracked, View } from "nsh";
import { paneWidth } from "../../app/pane-width";
import {
  Button,
  Caption,
  colors,
  Field,
  grow,
  Icon,
  Label,
  PaneHandle,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import {
  chatText,
  sendShortcut,
  shownMentions,
} from "../../components/eta-editor";
import { StatusDot } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useAgentMentions } from "../../services/agent-mentions";
import { relativeTime, useHost } from "../../services/host";
import { TaskActivity } from "./activity";
import { actorLabel, CreatorChip } from "./creator";
import {
  NeighbourStrip,
  Prerequisites,
  Subtasks,
  TaskLink,
} from "./dependencies";
import { createDescription, DescriptionBox } from "./description-box";
import { runningFor, taskMoment, taskWhen } from "./facts";
import { activeTaskRun, runCaption, runElapsed } from "./run-log";
import { statusName, TaskGlyph } from "./status";
import { TabletOverview } from "./tablet-overview";
import { TaskCommentBox, TaskFields, TaskRail } from "./task-fields";
import { PhoneRunTokens, TaskUsageSection } from "./usage-section";

function RunSummary(props: { item: BoardTaskDetail; state: TaskDetailState }) {
  const c = colors();
  const { executor, log, stop, submitting } = props.state;
  const run = () => props.item.runs.at(-1);
  const review = () => props.item.status === "in_review";
  const caption = (entry: TaskRunView) =>
    review()
      ? `Run ${props.item.runs.length} · ${uiText("taskRunCompletedIn", {
          time: runElapsed(entry),
        })}`
      : runCaption(entry, props.item.runs.length - 1);
  return (
    <If
      when={review() || props.item.status === "in_progress" ? run() : undefined}
    >
      {(entry) => (
        <View
          style={{
            ...row,
            paddingVertical: 10,
            paddingHorizontal: space[12],
            gap: 10,
            borderWidth: 1,
            borderColor: review() ? c().warning : c().strong,
          }}
        >
          <If when={!review()}>
            <StatusDot color={c().blue} size={8} />
          </If>
          <View
            role="button"
            accessibilityLabel={uiText("executionLog")}
            style={{
              ...row,
              flex: 1,
              minWidth: 0,
              gap: 10,
              cursor: "pointer",
            }}
            onPress={() => log.set(entry())}
          >
            <View style={{ flex: 1, gap: space[2] }}>
              <Label variant="small" weight={weight.strong}>
                {uiText(review() ? "taskDeliveredTurn" : "taskIsWorking", {
                  name: executor()?.name ?? uiText("executor"),
                })}
              </Label>
              <Label variant="caption" tone="muted">
                {uiText("executionLogWithCount", {
                  runCaption: caption(entry()),
                })}
              </Label>
            </View>
            <Icon name="right" size={14} tone="muted" />
          </View>
          <If when={activeTaskRun(entry())}>
            <Button
              label={uiText("stop")}
              disabled={submitting()}
              onPress={() => stop(entry())}
            />
          </If>
        </View>
      )}
    </If>
  );
}

/** One run on the phone's task page: its state and how long, the whole row opening its log. */
function RunRow(props: {
  run: TaskRunView;
  taskId: string;
  index: number;
  last: boolean;
  executor: string;
  onPress: () => void;
}) {
  const c = colors();
  const host = useHost();
  const active = () => activeTaskRun(props.run);
  const state = () =>
    props.run.status === "queued"
      ? uiText("queued")
      : active()
        ? uiText("running")
        : props.run.status === "completed"
          ? uiText("completed")
          : props.run.status === "failed"
            ? uiText("failed")
            : uiText("taskRunStopped");
  return (
    <View
      role="button"
      accessibilityLabel={uiText("executionLog")}
      onPress={props.onPress}
      activeStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: control.touch,
        gap: 10,
        borderTopWidth: 1,
        borderBottomWidth: props.last ? 1 : 0,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ marginHorizontal: 6 }}>
        <StatusDot
          color={
            active()
              ? c().blue
              : props.run.status === "completed"
                ? c().green
                : props.run.status === "failed"
                  ? c().red
                  : c().muted
          }
          size={8}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label variant="small" lines={1}>
          {uiText("taskRunExecutor", {
            number: props.index + 1,
            name:
              (props.run.agentId && host.agent(props.run.agentId)?.name) ||
              props.executor,
          })}
        </Label>
        <Label variant="caption" lines={1} tone={active() ? "blue" : "muted"}>
          {`${state()} · ${runElapsed(props.run)}`}
        </Label>
      </View>
      <PhoneRunTokens
        taskId={props.taskId}
        runId={props.run.id}
        session={props.run.sessionId}
      />
      <Icon name="right" size={14} tone="muted" />
    </View>
  );
}

/** The run's state in one line above the reply box, on desktop and tablet. */
export function RunLine(props: {
  item: BoardTaskDetail;
  state: TaskDetailState;
  tablet?: boolean;
}) {
  const c = colors();
  const { executor, log, stop, submitting } = props.state;
  const run = () => props.item.runs.at(-1);
  const review = () => props.item.status === "in_review";
  return (
    <If
      when={review() || props.item.status === "in_progress" ? run() : undefined}
    >
      {(entry) => (
        <View
          style={{
            ...row,
            justifyContent: "space-between",
            gap: space[8],
            paddingBottom: props.tablet ? 0 : space[8],
          }}
        >
          <View style={{ ...row, gap: props.tablet ? 8 : 6, flex: 1 }}>
            <If when={!review()}>
              <Icon name="spinner" size={props.tablet ? 14 : 12} tone="muted" />
            </If>
            <If when={!props.tablet && review()}>
              <StatusDot color={c().warning} />
            </If>
            <Label variant="caption" weight={weight.strong}>
              {uiText(review() ? "taskDeliveredTurn" : "taskIsWorking", {
                name: executor()?.name ?? uiText("executor"),
              })}
            </Label>
          </View>
          <View style={{ ...row, gap: props.tablet ? 8 : 14 }}>
            <View
              role="button"
              accessibilityLabel={uiText("executionLog")}
              onPress={() => log.set(entry())}
              style={{ cursor: "pointer" }}
            >
              <Label variant="caption" tone="muted">
                {uiText("executionLog")}
              </Label>
            </View>
            <If when={activeTaskRun(entry())}>
              <View
                role="button"
                accessibilityLabel={uiText("stop")}
                accessibilityState={{ disabled: submitting() }}
                onPress={() => {
                  if (!submitting()) stop(entry());
                }}
                style={{ ...row, gap: space[4], cursor: "pointer" }}
              >
                <Icon name="stop" size={props.tablet ? 12 : 10} />
                <Label variant="caption" weight={weight.strong}>
                  {uiText("stop")}
                </Label>
              </View>
            </If>
          </View>
        </View>
      )}
    </If>
  );
}

/** A task's page on desktop: its document in the middle, its properties in the rail. */
function DesktopOverview(props: {
  item: BoardTaskDetail;
  onTask: (id: string) => void;
  state: TaskDetailState;
}) {
  const agentMentions = useAgentMentions();
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const {
    activity,
    cancelling,
    describing,
    editDescription,
    editTitle,
    renaming,
    replacing,
    resolveBlock,
    saveDescription,
    saveTitle,
    search,
    submitting,
  } = props.state;
  const item = () => props.item;
  const parent = () => !!item().children?.length;
  const opensWithHeading = () => /^\s*#/.test(item().description);
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          style={{
            paddingTop: parent() ? 16 : 14,
            paddingBottom: space[20],
            paddingHorizontal: 22,
            width: "100%",
            maxWidth: parent() ? 724 : 667,
            alignSelf: "center",
            gap: parent() ? space[24] : 0,
          }}
        >
          <View style={{ gap: space[12], paddingBottom: parent() ? 0 : 0 }}>
            <Label variant={parent() ? "small" : "caption"} tone="muted">
              {parent()
                ? uiText("parentCreatedBy", {
                    number: item().number,
                    name: actorLabel(item().createdBy, host.agent),
                  })
                : uiText("createdBy", {
                    number: item().number,
                    value2: "",
                    value3: actorLabel(item().createdBy, host.agent),
                    relativeTime: taskMoment(item().createdAt),
                    value5: item().ancestors?.at(-1)
                      ? ` · Part of #${item().ancestors!.at(-1)!.number}`
                      : "",
                  })}
            </Label>
            <View style={{ ...row, gap: 10, paddingBottom: parent() ? 0 : 22 }}>
              <TaskGlyph
                status={item().status}
                size={parent() ? icon.lg : icon.md}
              />
              <If
                when={renaming()}
                else={
                  <View
                    role="button"
                    accessibilityLabel={uiText("changeTitle")}
                    onPress={() => {
                      editTitle.set(item().title);
                      renaming.set(true);
                    }}
                    style={{ flex: 1, minWidth: 0, cursor: "text" }}
                  >
                    <Label
                      variant={parent() ? "title" : "subtitle"}
                      weight={weight.strong}
                    >
                      {item().title}
                    </Label>
                  </View>
                }
              >
                <Field
                  label={uiText("changeTitle")}
                  value={editTitle()}
                  onChange={editTitle.set}
                  onSubmit={saveTitle}
                  onBlur={saveTitle}
                  inputRef={(ref) => queueMicrotask(() => ref.focus())}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    height: space[32],
                    paddingHorizontal: space[8],
                    borderColor: c().ink,
                    ...textStyle(type("subtitle")),
                    fontWeight: weight.strong,
                  }}
                />
              </If>
            </View>
          </View>
          <Prerequisites
            item={item()}
            compact
            submitting={submitting()}
            onResolve={() => resolveBlock()}
            onReplace={() => {
              search.set("");
              replacing.set(true);
            }}
            onCancel={() => cancelling.set(true)}
            onTask={props.onTask}
          />
          <If when={!parent()}>
            <NeighbourStrip item={item()} onTask={props.onTask} />
          </If>
          <If when={parent()}>
            <Subtasks item={item()} onTask={props.onTask} />
            <TaskUsageSection item={item()} layout="desktop" />
          </If>
          <If when={item().description}>
            <If
              when={parent()}
              else={
                <View style={{ gap: space[12], paddingBottom: space[20] }}>
                  <If
                    when={!describing()}
                    else={
                      <DescriptionEditor
                        value={editDescription()}
                        disabled={submitting()}
                        onCancel={() => describing.set(false)}
                        onSave={saveDescription}
                      />
                    }
                  >
                    <If when={!opensWithHeading()}>
                      <Label variant="subtitle" weight={weight.strong}>
                        {uiText("goal")}
                      </Label>
                    </If>
                    <chatText.View
                      plugins={[shownMentions()]}
                      text={{
                        text: item().description,
                        mentions: agentMentions(),
                      }}
                      label={uiText("description")}
                      variant="small"
                    />
                    <View
                      role="button"
                      accessibilityLabel={uiText("editDescription")}
                      onPress={() => {
                        editDescription.set(item().description);
                        describing.set(true);
                      }}
                      style={{
                        ...row,
                        alignSelf: "flex-start",
                        gap: 5,
                        cursor: "pointer",
                      }}
                    >
                      <Icon name="pencil" size={10} tone="muted" />
                      <Label variant="caption" tone="muted">
                        {uiText("editDescription")}
                      </Label>
                    </View>
                  </If>
                </View>
              }
            >
              <View style={{ gap: 6 }}>
                <Label weight={weight.strong}>{uiText("description")}</Label>
                <chatText.View
                  plugins={[shownMentions()]}
                  text={{ text: item().description, mentions: agentMentions() }}
                  label={uiText("description")}
                />
              </View>
            </If>
          </If>
          <If when={!parent()}>
            <TaskUsageSection item={item()} layout="desktop" />
          </If>
          <TaskActivity
            heading="desktop"
            entries={activity()}
            runs={item().runs}
            createdBy={item().createdBy}
            onLog={(run) => props.state.log.set(run)}
            onTask={props.onTask}
            onArtifact={(artifact, version) =>
              props.state.artifact.set({ artifact, version })
            }
          />
          <RunLine item={item()} state={props.state} />
          <TaskCommentBox state={props.state} />
        </View>
      </SmoothScroll>
      <View
        style={{
          width: paneWidth("task"),
          paddingVertical: space[20],
          paddingHorizontal: space[16],
          borderLeftWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <TaskRail item={item()} state={props.state} onTask={props.onTask} />
        <PaneHandle pane="task" />
      </View>
    </View>
  );
}

export function TaskOverview(props: {
  item: BoardTaskDetail;
  layout: Layout;
  docked?: boolean;
  onTask: (id: string) => void;
  state: TaskDetailState;
}) {
  const agentMentions = useAgentMentions();
  const host = useHost();
  const c = colors();
  const {
    activity,
    cancelling,
    describing,
    editDescription,
    executor,
    log,
    phone,
    replacing,
    resolveBlock,
    saveDescription,
    search,
    side,
    status,
    stop,
    submitting,
  } = props.state;
  const item = () => props.item;
  const parent = () => !!item().subtasks?.total;
  const opensWithHeading = () => /^\s*#/.test(item().description);
  const partOf = () => {
    const up = item().ancestors?.at(-1);
    if (!up) return "";
    return phone()
      ? ` · ${uiText("taskPartOf", { number: up.number, title: up.title })}`
      : ` · Part of #${up.number}`;
  };
  /** The phone's one status line, toned as a whole: "In progress · Executor Ada · Own git worktree". */
  const statusLine = () =>
    [
      item().status === "in_review" && !parent()
        ? uiText("forYouToCheck2")
        : statusName(item().status),
      parent() ? uiText("taskAuto") : undefined,
      executor()
        ? uiText("taskExecutorName", { name: executor()!.name })
        : undefined,
      parent()
        ? undefined
        : item().workspace.mode === "worktree"
          ? uiText("taskOwnWorktree")
          : uiText("taskProjectDirectory"),
    ]
      .filter(Boolean)
      .join(" · ");
  const statusTone = () =>
    item().status === "in_progress"
      ? "blue"
      : item().status === "in_review"
        ? "warning"
        : "mutedInk";
  const prerequisiteState = (edge: TaskDependencyView) => {
    if (edge.status === "cancelled" || edge.state === "cancelled")
      return uiText("taskEdgeCancelled");
    if (edge.status === "done") return uiText("taskEdgeDone");
    if (edge.state === "resolved") return uiText("taskEdgeDelivered");
    if (edge.status === "in_progress") {
      const task = host.tasks().find((other) => other.id === edge.taskId);
      return task ? `■ ${runningFor(task)}` : uiText("running");
    }
    return statusName(edge.status);
  };
  return (
    <If
      when={props.layout !== "tablet" || props.docked}
      else={
        <TabletOverview
          item={item()}
          onTask={props.onTask}
          state={props.state}
        />
      }
    >
      <If
        when={!side()}
        else={
          <DesktopOverview
            item={item()}
            onTask={props.onTask}
            state={props.state}
          />
        }
      >
        <View style={{ ...row, ...grow, alignItems: "stretch" }}>
          <SmoothScroll style={grow} scrollbar={false}>
            <View
              style={{
                paddingHorizontal: phone() ? space[16] : space[20],
                paddingTop: phone() ? space[16] : space[12],
                paddingBottom: phone() ? space[16] : space[20],
                width: "100%",
                maxWidth: 728,
                alignSelf: "center",
                gap: phone() ? space[20] : space[12],
              }}
            >
              <View style={{ gap: phone() ? space[8] : space[12] }}>
                <Label variant="caption" tone="muted">
                  {uiText("createdBy", {
                    number: item().number,
                    value2: item().subtasks?.total ? " · Parent" : "",
                    value3: actorLabel(item().createdBy, host.agent),
                    relativeTime: phone()
                      ? taskWhen(item().createdAt)
                      : relativeTime(item().createdAt),
                    value5: partOf(),
                  })}
                </Label>
                <View style={{ ...row, gap: phone() ? 8 : 10 }}>
                  <TaskGlyph status={item().status} size={phone() ? 18 : 16} />
                  <If
                    when={phone()}
                    else={
                      <Label
                        variant="title"
                        weight={weight.strong}
                        style={{ flex: 1 }}
                      >
                        {item().title}
                      </Label>
                    }
                  >
                    <TitleInPlace
                      title={item().title}
                      state={props.state}
                      variant="subtitle"
                      weight={weight.strong}
                    />
                  </If>
                </View>
                <If when={phone()}>
                  <View
                    role={parent() ? undefined : "button"}
                    accessibilityLabel={
                      parent() ? undefined : uiText("changeStatus")
                    }
                    onPress={parent() ? undefined : () => status.set(true)}
                    style={{ alignSelf: "flex-start" }}
                  >
                    <Label variant="small" tone={statusTone()}>
                      {statusLine()}
                    </Label>
                  </View>
                </If>
              </View>
              <CreatorChip creator={item().createdBy} />
              <If when={phone()}>
                <RunSummary item={item()} state={props.state} />
              </If>
              <Prerequisites
                item={item()}
                submitting={submitting()}
                onResolve={() => resolveBlock()}
                onReplace={() => {
                  search.set("");
                  replacing.set(true);
                }}
                onCancel={() => cancelling.set(true)}
                onTask={props.onTask}
              />
              <If when={item().children?.length}>
                <Subtasks item={item()} phone={phone()} onTask={props.onTask} />
              </If>
              <If when={phone() && describing()}>
                <DescriptionEditor
                  phone
                  value={editDescription()}
                  disabled={submitting()}
                  onCancel={() => describing.set(false)}
                  onSave={saveDescription}
                />
              </If>
              <If when={phone() && !describing() && !item().description.trim()}>
                <EditDescriptionLink
                  iconSize={11}
                  onPress={() => {
                    editDescription.set("");
                    describing.set(true);
                  }}
                />
              </If>
              <If when={item().description && !(phone() && describing())}>
                <View
                  style={{
                    gap: 6,
                    // The first heading's space above is the section gap's already.
                    marginTop: phone() && opensWithHeading() ? -9 : 0,
                  }}
                >
                  <If when={!phone() || !opensWithHeading()}>
                    <Label weight={weight.strong}>
                      {item().children?.length
                        ? uiText("description")
                        : uiText("goal")}
                    </Label>
                  </If>
                  <chatText.View
                    plugins={[shownMentions()]}
                    text={{
                      text: item().description,
                      mentions: agentMentions(),
                    }}
                    label={uiText("description")}
                  />
                  <If when={phone()}>
                    <EditDescriptionLink
                      iconSize={11}
                      onPress={() => {
                        editDescription.set(item().description);
                        describing.set(true);
                      }}
                    />
                  </If>
                </View>
              </If>
              <TaskUsageSection
                item={item()}
                layout={phone() ? "phone" : props.layout}
              />
              <If
                when={
                  item().waitingOn?.length ||
                  item().dependsOn?.length ||
                  item().dependents?.length
                }
              >
                <View>
                  <Caption
                    text={uiText("dependencies")}
                    style={{ paddingBottom: 6 }}
                  />
                  <Each
                    of={item().dependsOn ?? []}
                    key={(entry) => entry.taskId}
                  >
                    {(entry, index) => (
                      <TaskLink
                        onTask={props.onTask}
                        item={entry()}
                        suffix={uiText("taskWaitsForIt", {
                          state: prerequisiteState(entry()),
                        })}
                        tone={
                          entry().status === "in_progress" &&
                          entry().state !== "resolved"
                            ? "blue"
                            : undefined
                        }
                        last={
                          !item().dependents?.length &&
                          index() === (item().dependsOn?.length ?? 0) - 1
                        }
                      />
                    )}
                  </Each>
                  <Each
                    of={item().dependents ?? []}
                    key={(entry) => entry.taskId}
                  >
                    {(entry, index) => (
                      <TaskLink
                        onTask={props.onTask}
                        item={entry()}
                        suffix={
                          item().status === "in_review"
                            ? `${uiText("taskWaitsForThisTask")} · ${uiText("taskGoesNext")}`
                            : uiText("taskWaitsForThisTask")
                        }
                        last={index() === (item().dependents?.length ?? 0) - 1}
                      />
                    )}
                  </Each>
                </View>
              </If>
              <If
                when={
                  item().runs.length &&
                  (!phone() || item().status !== "blocked")
                }
              >
                <View style={{ gap: phone() ? 0 : space[12] }}>
                  <Caption
                    text={uiText("runs", { length: item().runs.length })}
                    style={phone() ? { paddingBottom: 6 } : undefined}
                  />
                  <Each of={item().runs} key={(run) => run.id}>
                    {(run, index) => (
                      <If
                        when={phone()}
                        else={
                          <View
                            style={{
                              ...row,
                              gap: 7,
                              padding: space[8],
                              borderWidth: 1,
                              borderColor: c().border,
                            }}
                          >
                            <Label variant="small" style={{ flex: 1 }}>
                              {run().status}
                            </Label>
                            <Button
                              label={uiText("runLog")}
                              end="right"
                              onPress={() => log.set(run())}
                            />
                            <If when={activeTaskRun(run())}>
                              <Button
                                label={uiText("stop")}
                                disabled={submitting()}
                                onPress={() => stop(run())}
                              />
                            </If>
                          </View>
                        }
                      >
                        <RunRow
                          run={run()}
                          taskId={item().id}
                          index={index()}
                          last={index() === item().runs.length - 1}
                          executor={executor()?.name ?? uiText("executor")}
                          onPress={() => log.set(run())}
                        />
                      </If>
                    )}
                  </Each>
                </View>
              </If>
              <TaskActivity
                heading={phone() ? "phone" : "desktop"}
                entries={activity()}
                runs={item().runs}
                createdBy={item().createdBy}
                onLog={(run) => log.set(run)}
                onTask={props.onTask}
                onArtifact={(artifact, version) =>
                  props.state.artifact.set({ artifact, version })
                }
              />
              <If when={!phone()}>
                <TaskCommentBox state={props.state} />
              </If>
              <If when={!phone() && !side() && props.docked}>
                <TaskFields item={item()} state={props.state} />
              </If>
            </View>
          </SmoothScroll>
        </View>
      </If>
    </If>
  );
}

/**
 * The description edited in place: the WYSIWYG editor (`DescriptionBox`, 240 high, 200 on a
 * phone, scrolling inside), Cancel and Save under it. ⏎ is a new line; ⌘⏎ saves.
 */
export function DescriptionEditor(props: {
  /** The description as kept (Markdown). */
  value: string;
  disabled: boolean;
  /** The task's own agents, offered first by `@`. */
  agents?: () => readonly string[];
  /** Tablet's 24px buttons. */
  tablet?: boolean;
  phone?: boolean;
  onCancel: () => void;
  onSave: (text: string) => void;
}) {
  const description = createDescription({
    text: untracked(() => props.value),
    agents: props.agents,
    onSubmit: () => save(),
  });
  function save() {
    if (props.disabled || description.tooLong()) return;
    props.onSave(description.read());
  }
  const button = () =>
    props.phone
      ? { size: 32, padding: 14 }
      : props.tablet
        ? { size: 24, padding: 10 }
        : { size: undefined, padding: 10 };
  return (
    <View style={{ gap: props.phone ? space[16] : space[8] }}>
      <DescriptionBox
        description={description}
        label={uiText("editDescription")}
        phone={!!props.phone}
        autoFocus
      />
      <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
        <Button
          label={uiText("cancel")}
          tone="ghost"
          size={button().size}
          style={{ paddingHorizontal: button().padding }}
          onPress={props.onCancel}
        />
        <Button
          label={uiText("save")}
          tone="primary"
          shortcut={props.phone ? undefined : sendShortcut}
          disabled={props.disabled || description.tooLong()}
          size={button().size}
          style={{ paddingHorizontal: button().padding }}
          onPress={save}
        />
      </View>
    </View>
  );
}

/** The muted pencil link under a description that opens it in place. */
export function EditDescriptionLink(props: {
  iconSize?: number;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={uiText("editDescription")}
      onPress={props.onPress}
      style={{ ...row, alignSelf: "flex-start", gap: 5, cursor: "pointer" }}
    >
      <Icon name="pencil" size={props.iconSize ?? 10} tone="muted" />
      <Label variant="caption" tone="muted">
        {uiText("editDescription")}
      </Label>
    </View>
  );
}

/** A title that turns into a field when pressed, saved on Enter or when it loses focus. */
export function TitleInPlace(props: {
  title: string;
  state: TaskDetailState;
  variant: TextVariant;
  weight: number;
}) {
  const c = colors();
  const type = textFaces();
  const { editTitle, renaming, saveTitle } = props.state;
  return (
    <If
      when={renaming()}
      else={
        <View
          role="button"
          accessibilityLabel={uiText("changeTitle")}
          onPress={() => {
            editTitle.set(props.title);
            renaming.set(true);
          }}
          style={{ flex: 1, minWidth: 0, cursor: "text" }}
        >
          <Label variant={props.variant} weight={props.weight}>
            {props.title}
          </Label>
        </View>
      }
    >
      <Field
        label={uiText("changeTitle")}
        value={editTitle()}
        onChange={editTitle.set}
        onSubmit={saveTitle}
        onBlur={saveTitle}
        inputRef={(ref) => queueMicrotask(() => ref.focus())}
        style={{
          flex: 1,
          minWidth: 0,
          height: type(props.variant).line + 8,
          paddingHorizontal: space[8],
          borderColor: c().ink,
          ...textStyle(type(props.variant)),
          fontWeight: weight.strong,
        }}
      />
    </If>
  );
}
