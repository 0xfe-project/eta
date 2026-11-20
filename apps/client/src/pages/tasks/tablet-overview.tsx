import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { Scroll, View } from "nsh";
import { colors, grow, Icon, Label, Markdown, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity } from "./activity";
import { NeighbourStrip, Prerequisites, Subtasks } from "./dependencies";
import { taskMoment } from "./facts";
import { StatusOptions, TaskMenu } from "./menu";
import { activeTaskRun } from "./run-log";
import { Segmented } from "./segmented";
import { statusName, TaskGlyph, tones } from "./status";
import { statusFill, TaskCommentBox, taskRunText } from "./task-fields";
import {
  DescriptionEditor,
  EditDescriptionLink,
  RunLine,
  TitleInPlace,
} from "./task-overview";

/** A task's page on tablet: its properties under the title, the run line and the reply box pinned below. */
export function TabletOverview(props: {
  item: BoardTaskDetail;
  onTask: (id: string) => void;
  state: TaskDetailState;
}) {
  const host = useHost();
  const {
    activity,
    canComment,
    cancelling,
    describing,
    editDescription,
    plan,
    replacing,
    resolveBlock,
    saveDescription,
    search,
    submitting,
  } = props.state;
  const item = () => props.item;
  const parent = () => !!item().children?.length;
  const creator = () =>
    host.agent(item().createdBy.agentId)?.name ?? uiText("taskMe");
  return (
    <View style={grow}>
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{
            paddingHorizontal: 20,
            paddingTop: 14,
            paddingBottom: 12,
            gap: 12,
          }}
        >
          <View style={{ ...row, gap: 8 }}>
            <Label size={10} line={12} tone="muted" style={{ flex: 1 }}>
              {parent()
                ? uiText("parentCreatedBy", {
                    number: item().number,
                    name: creator(),
                  })
                : uiText("createdBy", {
                    number: item().number,
                    value2: "",
                    value3: creator(),
                    relativeTime: taskMoment(item().createdAt),
                    value5: item().ancestors?.at(-1)
                      ? ` · Part of #${item().ancestors!.at(-1)!.number}`
                      : "",
                  })}
            </Label>
            <If when={parent()}>
              <Segmented
                options={[
                  { value: "overview", label: uiText("overview") },
                  { value: "plan", label: uiText("plan") },
                ]}
                value={plan() ? "plan" : "overview"}
                height={20}
                labelSize={11}
                paddingHorizontal={8}
                strong
                onChange={(value) => plan.set(value === "plan")}
              />
            </If>
          </View>
          <View style={{ ...row, gap: 8 }}>
            <TaskGlyph status={item().status} size={18} />
            <TitleInPlace
              title={item().title}
              state={props.state}
              size={18}
              line={22}
              weight={600}
            />
            <If
              when={!parent()}
              else={
                <Label size={11} line={14} tone={tones[item().status]}>
                  {`${statusName(item().status)} · ${uiText("taskAuto")}`}
                </Label>
              }
            >
              <StatusSelect item={item()} state={props.state} />
            </If>
          </View>
          <Prerequisites
            item={item()}
            compact
            tablet
            submitting={submitting()}
            onResolve={() => resolveBlock()}
            onReplace={() => {
              search.set("");
              replacing.set(true);
            }}
            onCancel={() => cancelling.set(true)}
            onTask={props.onTask}
          />
          <Properties item={item()} state={props.state} />
          <If
            when={parent()}
            else={<NeighbourStrip item={item()} tablet onTask={props.onTask} />}
          >
            <Subtasks item={item()} tablet onTask={props.onTask} />
          </If>
          <If when={describing()}>
            <DescriptionEditor
              tablet
              value={editDescription()}
              disabled={submitting()}
              onChange={editDescription.set}
              onCancel={() => describing.set(false)}
              onSave={saveDescription}
            />
          </If>
          <If when={!describing()}>
            <View style={{ gap: parent() ? 3 : 4 }}>
              <If
                when={
                  item().description &&
                  (parent() || !/^\s*#/.test(item().description))
                }
              >
                <Label size={13} line={16} weight={600}>
                  {parent() ? uiText("description") : uiText("goal")}
                </Label>
              </If>
              <If when={item().description}>
                <Markdown
                  value={item().description}
                  size={12}
                  line={16}
                  heading={{
                    size: 13,
                    line: 16,
                    weight: 600,
                    space: 0,
                    after: -8,
                  }}
                  compactHeadings
                />
              </If>
              <View style={{ paddingTop: item().description ? 4 : 0 }}>
                <EditDescriptionLink
                  onPress={() => {
                    editDescription.set(item().description);
                    describing.set(true);
                  }}
                />
              </View>
            </View>
          </If>
          <TaskActivity phone={false} tablet entries={activity()} />
        </View>
      </Scroll>
      <View style={{ paddingHorizontal: 20, paddingBottom: 14, gap: 12 }}>
        <RunLine item={item()} state={props.state} tablet />
        <If when={canComment(item())}>
          <TaskCommentBox state={props.state} tablet />
        </If>
      </View>
    </View>
  );
}

/**
 * The status next to the title, tinted in the status's colour while it runs or
 * waits for review; it opens the "Change status" popover, a hint under each status.
 */
function StatusSelect(props: {
  item: BoardTaskDetail;
  state: TaskDetailState;
}) {
  const c = colors();
  const { change, status } = props.state;
  const tint = () =>
    statusFill[props.item.status as keyof typeof statusFill] as
      | (typeof statusFill)[keyof typeof statusFill]
      | undefined;
  const ink = () => (tint() ? tones[props.item.status] : "ink");
  return (
    <TaskMenu
      width={264}
      align="end"
      caption={uiText("changeStatus")}
      open={status()}
      onOpenChange={status.set}
      trigger={
        <View
          accessibilityLabel={uiText("changeStatus")}
          style={{
            ...row,
            height: tint() ? 28 : 22,
            minWidth: tint() ? 128 : undefined,
            paddingHorizontal: 8,
            gap: 6,
            borderWidth: 1,
            borderColor: tint() ? c()[tones[props.item.status]] : c().strong,
            backgroundColor: tint() ? c()[tint()!] : c().canvas,
            cursor: "pointer",
          }}
        >
          <If when={tint()}>
            <TaskGlyph status={props.item.status} size={14} />
          </If>
          <Label
            size={tint() ? 12 : 11}
            line={tint() ? 16 : 14}
            weight={tint() ? 400 : 600}
            tone={ink()}
            style={tint() ? { flex: 1 } : undefined}
          >
            {statusName(props.item.status)}
          </Label>
          <Icon name="down" size={tint() ? 14 : 10} tone={ink()} />
        </View>
      }
    >
      <StatusOptions
        current={props.item.status}
        waiting={props.item.dependents?.length ?? 0}
        onChange={change}
      />
    </TaskMenu>
  );
}

/** Every property of the task in two columns: what it is on the left, what it waits on the right. */
function Properties(props: { item: BoardTaskDetail; state: TaskDetailState }) {
  const c = colors();
  const host = useHost();
  const item = () => props.item;
  const parent = () => !!item().children?.length;
  const run = () => item().runs.at(-1);
  /** A stopped or finished run starts over from its row, as on the desktop rail. */
  const canStartOver = () => !parent() && !!run() && !activeTaskRun(run()!);
  const executor = () =>
    host.agent(item().assigneeAgentId ?? item().createdBy.agentId)?.name ??
    uiText("unassigned");
  const workspace = () =>
    item().workspace.mode === "worktree"
      ? uiText("taskOwnWorktree")
      : uiText("taskProjectDirectory");
  const group = () =>
    host
      .conversations()
      .find((conversation) => conversation.id === item().originConversationId)
      ?.name;
  const belongsTo = () => {
    const entry = item().ancestors?.at(-1);
    return entry ? `#${entry.number} ${entry.title}` : undefined;
  };
  const edges = (
    list: { number: number; title: string }[] | undefined,
    state?: (index: number) => string,
  ) =>
    (list ?? [])
      .map(
        (edge, index) =>
          `#${edge.number} ${edge.title}${state ? ` · ${state(index)}` : ""}`,
      )
      .join(", ");
  const left = () =>
    parent()
      ? [
          [uiText("executor"), executor()],
          [uiText("taskGroup"), group()],
        ]
      : [
          [uiText("executor"), executor()],
          [uiText("taskBelongsTo"), belongsTo()],
          [uiText("workspace"), workspace()],
          [uiText("taskRun"), taskRunText(item())],
        ];
  const right = () =>
    parent()
      ? [
          [uiText("workspace"), workspace()],
          [uiText("taskUpdated"), taskMoment(item().updatedAt)],
        ]
      : [
          [
            uiText("taskWaitsForLabel"),
            edges(item().dependsOn, (index) => {
              const edge = item().dependsOn![index]!;
              return edge.state === "resolved"
                ? uiText("taskReady")
                : edge.state === "cancelled"
                  ? statusName("cancelled")
                  : uiText("taskWaitingState");
            }),
          ],
          [uiText("waitedOnBy"), edges(item().dependents)],
          [uiText("taskUpdated"), taskMoment(item().updatedAt)],
        ];
  return (
    <View
      style={{
        ...row,
        alignItems: "flex-start",
        gap: 24,
        paddingVertical: parent() ? 8 : 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <Each
        of={[left(), right()].map((column) =>
          column.filter(
            ([label, value]) => value || label === uiText("taskBelongsTo"),
          ),
        )}
        key="index"
      >
        {(column) => (
          <View style={{ flex: 1, minWidth: 0, gap: parent() ? 5 : 6 }}>
            <Each of={column()} key={(field) => field[0]!}>
              {(field) => (
                <View style={{ ...row, alignItems: "flex-start", gap: 8 }}>
                  <Label
                    size={10}
                    line={12}
                    tone="muted"
                    style={{ width: parent() ? 64 : 74, flexShrink: 0 }}
                  >
                    {field()[0]}
                  </Label>
                  <If
                    when={field()[1]}
                    else={
                      <Label size={11} line={14} tone="muted">
                        {uiText("pickAPieceOfWork")}
                      </Label>
                    }
                  >
                    <Label
                      size={11}
                      line={14}
                      weight={600}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {field()[1]}
                    </Label>
                    <If
                      when={field()[0] === uiText("taskRun") && canStartOver()}
                    >
                      <View
                        role="button"
                        accessibilityLabel={uiText("rerun")}
                        accessibilityDescription={uiText("startOverHint")}
                        onPress={() =>
                          void props.state.mutate(async () => {
                            await host.call("tasks", "rerun", {
                              taskId: item().id,
                            });
                          })
                        }
                        hoverStyle={{ backgroundColor: c().selected }}
                        style={{
                          ...row,
                          height: 18,
                          marginVertical: -2,
                          paddingHorizontal: 4,
                          gap: 4,
                          flexShrink: 0,
                          cursor: "pointer",
                        }}
                      >
                        <Icon name="refresh" size={11} />
                        <Label size={11} line={14} weight={600}>
                          {uiText("rerun")}
                        </Label>
                      </View>
                    </If>
                  </If>
                </View>
              )}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}
