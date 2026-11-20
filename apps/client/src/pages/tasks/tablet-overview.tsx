import type { BoardTaskDetail } from "@eta/client-contracts";
import type { TaskDetailState } from "./task-detail-state";
import { TASK_STATUSES } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import { Menu, MenuItem } from "nsh/base";
import { colors, grow, Icon, Label, Markdown, row } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskActivity } from "./activity";
import { NeighbourStrip, Prerequisites, Subtasks } from "./dependencies";
import { taskMoment } from "./facts";
import { Segmented } from "./segmented";
import { statusName, TaskGlyph, tones } from "./status";
import { statusFill, TaskCommentBox, taskRunText } from "./task-fields";
import { RunLine } from "./task-overview";

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
    plan,
    replacing,
    resolveBlock,
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
            <Label size={18} line={22} weight={600} style={{ flex: 1 }}>
              {item().title}
            </Label>
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
          <Properties item={item()} />
          <If
            when={parent()}
            else={<NeighbourStrip item={item()} tablet onTask={props.onTask} />}
          >
            <Subtasks item={item()} tablet onTask={props.onTask} />
          </If>
          <If when={item().description}>
            <View style={{ gap: parent() ? 3 : 4 }}>
              <If when={parent() || !/^\s*#/.test(item().description)}>
                <Label size={13} line={16} weight={600}>
                  {parent() ? uiText("description") : uiText("goal")}
                </Label>
              </If>
              <Markdown value={item().description} line={16} compactHeadings />
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

/** The status next to the title: tinted in the status's colour while it runs or waits for review. */
function StatusSelect(props: {
  item: BoardTaskDetail;
  state: TaskDetailState;
}) {
  const c = colors();
  const tint = () =>
    statusFill[props.item.status as keyof typeof statusFill] as
      | (typeof statusFill)[keyof typeof statusFill]
      | undefined;
  const ink = () => (tint() ? tones[props.item.status] : "ink");
  return (
    <Menu
      placement="bottom"
      align="end"
      offset={3}
      popupStyle={{
        width: 172,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
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
      <Each of={TASK_STATUSES}>
        {(entry) => (
          <MenuItem
            role="menuitemradio"
            checked={props.item.status === entry()}
            accessibilityLabel={statusName(entry())}
            style={{ ...row, minHeight: 33, paddingHorizontal: 9, gap: 6 }}
            hoverStyle={{ backgroundColor: c().selected }}
            indicatorStyle={{ width: 0 }}
            onSelect={() => props.state.change(entry())}
          >
            <TaskGlyph status={entry()} size={12} />
            <Label size={12} style={{ flex: 1 }}>
              {statusName(entry())}
            </Label>
            <If when={props.item.status === entry()}>
              <Icon name="check" size={12} />
            </If>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}

/** Every property of the task in two columns: what it is on the left, what it waits on the right. */
function Properties(props: { item: BoardTaskDetail }) {
  const c = colors();
  const host = useHost();
  const item = () => props.item;
  const parent = () => !!item().children?.length;
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
