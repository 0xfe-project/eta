import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { View } from "nsh";
import {
  colors,
  grow,
  Icon,
  Label,
  Markdown,
  row,
  SmoothScroll,
} from "../../components";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity } from "./activity";
import { actorLabel, CreatorChip } from "./creator";
import { NeighbourStrip, Prerequisites, Subtasks } from "./dependencies";
import { taskMoment } from "./facts";
import { activeTaskRun, latestExecutorRun } from "./run-log";
import { Segmented } from "./segmented";
import { statusName, TaskGlyph, tones } from "./status";
import { StatusSelect } from "./status-select";
import { TaskCommentBox, taskRunText } from "./task-fields";
import {
  DescriptionEditor,
  EditDescriptionLink,
  RunLine,
  TitleInPlace,
} from "./task-overview";
import { TaskUsageSection } from "./usage-section";

/** A task's page on tablet: its properties under the title, the run line and the reply box pinned below. */
export function TabletOverview(props: {
  item: BoardTaskDetail;
  onTask: (id: string) => void;
  state: TaskDetailState;
}) {
  const host = useHost();
  const {
    activity,
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
  const creator = () => actorLabel(item().createdBy, host.agent);
  return (
    <View style={grow}>
      <SmoothScroll style={grow} scrollbar={false}>
        <View
          style={{
            paddingHorizontal: space[20],
            paddingTop: space[16],
            paddingBottom: space[12],
            gap: space[12],
          }}
        >
          <View style={{ ...row, gap: space[8] }}>
            <Label variant="caption" tone="muted" style={{ flex: 1 }}>
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
                height={control.sm}
                labelVariant="caption"
                paddingHorizontal={space[8]}
                strong
                onChange={(value) => plan.set(value === "plan")}
              />
            </If>
          </View>
          <View style={{ ...row, gap: space[8] }}>
            <TaskGlyph status={item().status} size={icon.md} />
            <TitleInPlace
              title={item().title}
              state={props.state}
              variant="subtitle"
              weight={weight.strong}
            />
            <If
              when={!parent()}
              else={
                <Label variant="caption" tone={tones[item().status]}>
                  {`${statusName(item().status)} · ${uiText("taskAuto")}`}
                </Label>
              }
            >
              <StatusSelect
                item={item()}
                state={props.state}
                align="end"
                compact
              />
            </If>
          </View>
          <CreatorChip creator={item().createdBy} />
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
              onCancel={() => describing.set(false)}
              onSave={saveDescription}
            />
          </If>
          <If when={!describing()}>
            <View style={{ gap: parent() ? space[2] : space[4] }}>
              <If
                when={
                  item().description &&
                  (parent() || !/^\s*#/.test(item().description))
                }
              >
                <Label variant="small" weight={weight.strong}>
                  {parent() ? uiText("description") : uiText("goal")}
                </Label>
              </If>
              <If when={item().description}>
                <Markdown
                  value={item().description}
                  dense
                  heading={{
                    variant: "small",
                    weight: weight.strong,
                    space: 0,
                    after: -8,
                  }}
                  compactHeadings
                />
              </If>
              <View style={{ paddingTop: item().description ? space[4] : 0 }}>
                <EditDescriptionLink
                  onPress={() => {
                    editDescription.set(item().description);
                    describing.set(true);
                  }}
                />
              </View>
            </View>
          </If>
          <TaskUsageSection item={item()} layout="tablet" />
          <TaskActivity
            heading="tablet"
            entries={activity()}
            runs={item().runs}
            createdBy={item().createdBy}
            onLog={(run) => props.state.log.set(run)}
            onTask={props.onTask}
            onArtifact={(artifact, version) =>
              props.state.artifact.set({ artifact, version })
            }
          />
        </View>
      </SmoothScroll>
      <View
        style={{
          paddingHorizontal: space[20],
          paddingBottom: space[16],
          gap: space[12],
        }}
      >
        <RunLine item={item()} state={props.state} tablet />
        <TaskCommentBox state={props.state} />
      </View>
    </View>
  );
}

/** Every property of the task in two columns: what it is on the left, what it waits on the right. */
/** A property's label column (a parent has shorter labels); the inline Rerun under the run. */
const fieldLabelWidth = { parent: 64, task: 76 } as const;
const rerunHeight = 20;

function Properties(props: { item: BoardTaskDetail; state: TaskDetailState }) {
  const c = colors();
  const host = useHost();
  const item = () => props.item;
  const parent = () => !!item().children?.length;
  const run = () => latestExecutorRun(item());
  /** A stopped or finished run starts over from its row, as on the desktop rail. */
  const canStartOver = () => !parent() && !!run() && !activeTaskRun(run()!);
  const executor = () =>
    host.agent(item().assigneeAgentId ?? item().createdBy.agentId)?.name ??
    uiText("unassigned");
  const workspace = () =>
    item().workspace.mode === "worktree"
      ? uiText("taskOwnWorktree")
      : uiText("taskProjectDirectory");
  const group = () => host.conversation(item().originConversationId)?.name;
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
        gap: space[24],
        paddingVertical: parent() ? space[8] : space[12],
        paddingHorizontal: space[12],
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
          <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
            <Each of={column()} key={(field) => field[0]!}>
              {(field) => (
                <View
                  style={{ ...row, alignItems: "flex-start", gap: space[8] }}
                >
                  <Label
                    variant="caption"
                    tone="muted"
                    style={{
                      width: parent()
                        ? fieldLabelWidth.parent
                        : fieldLabelWidth.task,
                      flexShrink: 0,
                    }}
                  >
                    {field()[0]}
                  </Label>
                  <If
                    when={field()[1]}
                    else={
                      <Label variant="caption" tone="muted">
                        {uiText("pickAPieceOfWork")}
                      </Label>
                    }
                  >
                    <Label
                      variant="caption"
                      weight={weight.strong}
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
                          height: rerunHeight,
                          marginVertical: -space[2],
                          paddingHorizontal: space[4],
                          gap: space[4],
                          flexShrink: 0,
                          cursor: "pointer",
                        }}
                      >
                        <Icon name="refresh" size={icon.sm} />
                        <Label variant="caption" weight={weight.strong}>
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
