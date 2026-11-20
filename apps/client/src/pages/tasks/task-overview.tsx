import type { BoardTaskDetail } from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  grow,
  Icon,
  Label,
  Markdown,
  row,
} from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { TaskActivity } from "./activity";
import {
  NeighbourStrip,
  Prerequisites,
  Subtasks,
  TaskLink,
} from "./dependencies";
import { taskMoment } from "./facts";
import { activeTaskRun, runCaption } from "./run-log";
import { statusName, TaskGlyph, tones } from "./status";
import { TaskCommentBox, TaskFields, TaskRail } from "./task-fields";

function RunSummary(props: { item: BoardTaskDetail; state: TaskDetailState }) {
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
            minHeight: 56,
            paddingHorizontal: 10,
            gap: 8,
            borderWidth: 1,
            borderColor: review() ? c().amber : c().border,
          }}
        >
          <StatusDot color={c()[review() ? "amber" : "blue"]} size={8} />
          <View
            role="button"
            accessibilityLabel={uiText("executionLog")}
            style={{
              ...row,
              flex: 1,
              minWidth: 0,
              gap: 8,
              cursor: "pointer",
            }}
            onPress={() => log.set(entry())}
          >
            <View style={{ flex: 1, gap: 1 }}>
              <Label size={13} weight={600}>
                {(executor()?.name ?? "The executor") +
                  (review() ? " delivered this turn" : " is working")}
              </Label>
              <Label size={11} tone="muted">
                {uiText("executionLogWithCount", {
                  runCaption: runCaption(entry(), props.item.runs.length - 1),
                })}
              </Label>
            </View>
            <Icon name="right" size={10} tone="muted" />
          </View>
          <If when={activeTaskRun(entry())}>
            <Button
              label={uiText("stop")}
              size={26}
              disabled={submitting()}
              onPress={() => stop(entry())}
            />
          </If>
        </View>
      )}
    </If>
  );
}

/** The run's state in one line above the reply box, on desktop. */
function RunLine(props: { item: BoardTaskDetail; state: TaskDetailState }) {
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
            paddingBottom: 8,
          }}
        >
          <View style={{ ...row, gap: 6 }}>
            <StatusDot color={c()[review() ? "amber" : "blue"]} />
            <Label size={10} line={12} weight={600}>
              {uiText(review() ? "taskDeliveredTurn" : "taskIsWorking", {
                name: executor()?.name ?? uiText("executor"),
              })}
            </Label>
          </View>
          <View style={{ ...row, gap: 14 }}>
            <View
              role="button"
              accessibilityLabel={uiText("executionLog")}
              onPress={() => log.set(entry())}
              style={{ cursor: "pointer" }}
            >
              <Label size={10} line={12} tone="muted">
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
                style={{ ...row, gap: 4, cursor: "pointer" }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderWidth: 1,
                    borderColor: c().ink,
                  }}
                />
                <Label size={10} line={12} weight={600}>
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
  const host = useHost();
  const c = colors();
  const {
    activity,
    canComment,
    cancelling,
    editDescription,
    editing,
    editTitle,
    replacing,
    resolveBlock,
    search,
    submitting,
  } = props.state;
  const item = () => props.item;
  const parent = () => !!item().children?.length;
  const opensWithHeading = () => /^\s*#/.test(item().description);
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{
            paddingTop: parent() ? 16 : 14,
            paddingBottom: 20,
            paddingHorizontal: 22,
            width: "100%",
            maxWidth: parent() ? 724 : 667,
            alignSelf: "center",
            gap: parent() ? 24 : 0,
          }}
        >
          <View style={{ gap: 12, paddingBottom: parent() ? 0 : 0 }}>
            <Label
              size={parent() ? 12 : 10}
              line={parent() ? 16 : 12}
              tone="muted"
            >
              {parent()
                ? uiText("parentCreatedBy", {
                    number: item().number,
                    name:
                      host.agent(item().createdBy.agentId)?.name ??
                      uiText("taskMe"),
                  })
                : uiText("createdBy", {
                    number: item().number,
                    value2: "",
                    value3:
                      host.agent(item().createdBy.agentId)?.name ??
                      uiText("taskMe"),
                    relativeTime: taskMoment(item().createdAt),
                    value5: item().ancestors?.at(-1)
                      ? ` · Part of #${item().ancestors!.at(-1)!.number}`
                      : "",
                  })}
            </Label>
            <View style={{ ...row, gap: 10, paddingBottom: parent() ? 0 : 22 }}>
              <TaskGlyph status={item().status} size={parent() ? 20 : 16} />
              <Label
                size={parent() ? 20 : 18}
                line={parent() ? 24 : 22}
                weight={parent() ? 600 : 700}
                style={{ flex: 1 }}
              >
                {item().title}
              </Label>
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
          </If>
          <If when={item().description}>
            <If
              when={parent()}
              else={
                <View style={{ gap: 12, paddingBottom: 20 }}>
                  <If when={!opensWithHeading()}>
                    <Label size={16} line={20} weight={700}>
                      {uiText("goal")}
                    </Label>
                  </If>
                  <Markdown
                    value={item().description}
                    line={16}
                    compactHeadings
                  />
                  <View
                    role="button"
                    accessibilityLabel={uiText("editDescription")}
                    onPress={() => {
                      editTitle.set(item().title);
                      editDescription.set(item().description);
                      editing.set(true);
                    }}
                    style={{
                      ...row,
                      alignSelf: "flex-start",
                      gap: 5,
                      cursor: "pointer",
                    }}
                  >
                    <Label size={10} line={12} tone="muted">
                      {uiText("editDescription")}
                    </Label>
                  </View>
                </View>
              }
            >
              <View style={{ gap: 6 }}>
                <Label size={14} line={18} weight={600}>
                  {uiText("description")}
                </Label>
                <Markdown
                  value={item().description}
                  line={18}
                  compactHeadings
                />
              </View>
            </If>
          </If>
          <TaskActivity phone={false} desktop entries={activity()} />
          <RunLine item={item()} state={props.state} />
          <If when={canComment(item())}>
            <TaskCommentBox state={props.state} />
          </If>
        </View>
      </Scroll>
      <View
        style={{
          width: 280,
          paddingVertical: 20,
          paddingHorizontal: 16,
          borderLeftWidth: 1,
          borderColor: c().border,
          flexShrink: 0,
        }}
      >
        <TaskRail item={item()} state={props.state} onTask={props.onTask} />
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
  const host = useHost();
  const c = colors();
  const {
    activity,
    canComment,
    cancelling,
    change,
    executor,
    log,
    phone,
    replacing,
    resolveBlock,
    search,
    side,
    stop,
    submitting,
  } = props.state;
  const item = () => props.item;
  return (
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
        <Scroll style={grow} scrollbar={false}>
          <View
            style={{
              paddingHorizontal: phone() ? 16 : 20,
              paddingTop: 12,
              paddingBottom: 20,
              width: "100%",
              maxWidth: 728,
              alignSelf: "center",
              gap: 12,
            }}
          >
            <Label size={11} tone="muted">
              {uiText("createdBy", {
                number: item().number,
                value2: item().subtasks?.total ? " · Parent" : "",
                value3: host.agent(item().createdBy.agentId)?.name ?? "you",
                relativeTime: relativeTime(item().createdAt),
                value5: item().ancestors?.at(-1)
                  ? ` · Part of #${item().ancestors!.at(-1)!.number}`
                  : "",
              })}
            </Label>
            <View style={{ ...row, gap: 10 }}>
              <TaskGlyph status={item().status} size={16} />
              <Label
                size={phone() ? 18 : 20}
                line={phone() ? 24 : 26}
                weight={600}
                style={{ flex: 1 }}
              >
                {item().title}
              </Label>
              <If
                when={
                  props.layout === "tablet" &&
                  !props.docked &&
                  !item().children?.length
                }
              >
                <ActionMenu
                  label={uiText("changeStatus")}
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
            </View>
            <If when={phone()}>
              <View
                style={{
                  ...row,
                  flexWrap: "wrap",
                  gap: 5,
                  marginTop: -7,
                }}
              >
                <Label size={12} tone={tones[item().status]}>
                  {item().status === "in_review" && !item().children?.length
                    ? uiText("forYouToCheck2")
                    : statusName(item().status)}
                </Label>
                <If when={executor()}>
                  {(agent) => (
                    <Label size={12} tone="muted">
                      {uiText("executorWithCount", {
                        name: agent().name,
                      })}
                    </Label>
                  )}
                </If>
                <Label size={12} tone="muted">
                  {item().workspace.mode === "worktree"
                    ? uiText("ownGitWorktree")
                    : uiText("projectDirectory")}
                </Label>
              </View>
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
              <Subtasks item={item()} onTask={props.onTask} />
            </If>
            <If when={item().description}>
              <Label weight={600} size={15}>
                {item().children?.length
                  ? uiText("description")
                  : uiText("goal")}
              </Label>
              <Markdown
                value={item().description}
                line={22}
                compactHeadings={phone()}
              />
            </If>
            <If
              when={
                item().waitingOn?.length ||
                item().dependsOn?.length ||
                item().dependents?.length
              }
            >
              <Caption text={uiText("dependencies")} />
              <Each of={item().dependsOn ?? []} key={(entry) => entry.taskId}>
                {(entry) => (
                  <TaskLink
                    onTask={props.onTask}
                    item={entry()}
                    suffix={`Waits for it · ${entry().state === "resolved" ? "ready" : entry().state === "cancelled" ? "cancelled" : statusName(entry().status)}`}
                  />
                )}
              </Each>
              <Each of={item().dependents ?? []} key={(entry) => entry.taskId}>
                {(entry) => (
                  <TaskLink
                    onTask={props.onTask}
                    item={entry()}
                    suffix="Waits for this task"
                  />
                )}
              </Each>
            </If>
            <If
              when={
                item().runs.length && (!phone() || item().status !== "blocked")
              }
            >
              <Caption text={uiText("runs", { length: item().runs.length })} />
              <Each of={item().runs} key={(run) => run.id}>
                {(run) => (
                  <View
                    style={{
                      ...row,
                      gap: 7,
                      padding: 8,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label size={12} style={{ flex: 1 }}>
                      {phone()
                        ? runCaption(
                            run(),
                            item().runs.findIndex(
                              (entry) => entry.id === run().id,
                            ),
                          )
                        : run().status}
                    </Label>
                    <Button
                      label={uiText("runLog")}
                      end="right"
                      onPress={() => log.set(run())}
                    />
                    <If
                      when={
                        activeTaskRun(run()) &&
                        (!phone() || run().id !== item().runs.at(-1)?.id)
                      }
                    >
                      <Button
                        label={uiText("stop")}
                        disabled={submitting()}
                        onPress={() => stop(run())}
                      />
                    </If>
                  </View>
                )}
              </Each>
            </If>
            <TaskActivity phone={phone()} entries={activity()} />
            <If when={!phone() && canComment(item())}>
              <TaskCommentBox state={props.state} />
            </If>
            <If when={!phone() && !side() && props.docked}>
              <TaskFields item={item()} state={props.state} />
            </If>
          </View>
        </Scroll>
      </View>
    </If>
  );
}
