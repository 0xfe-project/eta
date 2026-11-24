import type { BoardTaskView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { signal, View } from "nsh";
import { colors, grow, Icon, Label, row, SmoothScroll } from "../../components";
import { dotSize } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { relativeTime, useHost } from "../../services/host";
import { ownerLine } from "./creator";
import {
  isWaiting,
  runningFor,
  stepOf,
  taskDay,
  taskHint,
  taskTime,
} from "./facts";
import { statusName, TaskGlyph } from "./status";
import {
  cardUsage,
  tokens,
  UsageLine,
  usageShown,
  usageText,
  useLiveRate,
} from "./usage";

/** A task's row in the phone's list and in the tablet's. */
const phoneRowHeight = 56;
const tabletRowHeight = 52;

/** The task table's columns, on the desktop and (…Tablet) on the tablet and phone. */
const columnWidth = {
  number: 36,
  numberTablet: 32,
  usage: 200,
  usageTablet: 96,
  hint: 184,
  hintTablet: 180,
  hintNested: 160,
  hintPhone: 72,
  owner: 152,
  ownerTablet: 92,
  time: 116,
  timeTablet: 80,
} as const;

const phoneGroups = [
  { name: "Needs you", label: "taskNeedsYou", fold: false },
  { name: "Running", label: "running", fold: false },
  { name: "Waiting for others", label: "taskWaitingForOthers", fold: false },
  { name: "Done", label: "taskDone", fold: true },
  { name: "Backlog", label: "backlog", fold: true },
  { name: "Cancelled", label: "taskCancelled", fold: true },
] as const;

function phoneTaskGroup(task: BoardTaskView) {
  switch (task.status) {
    case "in_review":
    case "blocked":
      return "Needs you";
    case "done":
      return "Done";
    case "backlog":
      return "Backlog";
    case "cancelled":
      return "Cancelled";
    case "in_progress":
      return task.runStatus === "queued" && !task.subtasks?.total
        ? "Waiting for others"
        : "Running";
    case "todo":
      return task.subtasks?.total ? "Running" : "Waiting for others";
  }
}

export function PhoneTaskList(props: {
  tasks: BoardTaskView[];
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const expanded = signal<string[]>([]);
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <Each of={phoneGroups}>
        {(group) => {
          const entries = () =>
            props.tasks.filter((task) => phoneTaskGroup(task) === group().name);
          const open = () => !group().fold || expanded().includes(group().name);
          return (
            <If when={group().fold || entries().length > 0}>
              <View
                role={group().fold ? "button" : undefined}
                accessibilityLabel={`${uiText(group().label)} ${entries().length}`}
                accessibilityState={
                  group().fold ? { expanded: open() } : undefined
                }
                onPress={
                  group().fold
                    ? () =>
                        expanded.update((names) =>
                          open()
                            ? names.filter((name) => name !== group().name)
                            : [...names, group().name],
                        )
                    : undefined
                }
                style={{
                  ...row,
                  height: group().fold ? space[32] : space[24],
                  paddingLeft: space[16],
                  paddingRight: group().fold ? space[12] : space[16],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  backgroundColor: group().fold ? c().canvas : c().surface,
                  gap: space[4],
                }}
              >
                <Label
                  tracking="caps"
                  variant="caption"
                  weight={weight.strong}
                  tone={group().name === "Needs you" ? "warning" : "mutedInk"}
                  style={{ textTransform: "uppercase" }}
                >
                  {uiText(group().label)}
                </Label>
                <Label
                  variant="caption"
                  tone={group().name === "Needs you" ? "warning" : "muted"}
                >
                  {entries().length}
                </Label>
                <If when={group().fold}>
                  <View style={{ flex: 1 }} />
                  <Icon
                    name={open() ? "down" : "right"}
                    size={icon.md}
                    tone="muted"
                  />
                </If>
              </View>
              <If when={open()}>
                <Each of={entries()} key={(entry) => entry.id}>
                  {(entry) => {
                    const owner = () => ownerLine(entry(), host.agent);
                    const state = () => {
                      const task = entry();
                      if (task.status === "in_review")
                        return uiText("forYouToCheck2");
                      if (task.status === "blocked")
                        return uiText("taskNeedsDecision");
                      if (task.subtasks?.total)
                        return uiText("parentTaskProgress", task.subtasks);
                      const wait = task.waitingOn?.[0];
                      if (wait) {
                        return uiText("waitsForTask", {
                          title: wait.title || `#${wait.number}`,
                        });
                      }
                      if (task.runStatus === "queued") return uiText("queued");
                      if (task.status === "in_progress")
                        return `■ ${runningFor(task)}`;
                      return statusName(task.status);
                    };
                    /** Only the state is toned, after the muted number and owner; a blocked row is muted ink throughout. */
                    const stateTone = () => {
                      const task = entry();
                      if (task.subtasks?.total) return undefined;
                      if (task.status === "in_review") return "warning";
                      if (
                        task.status === "in_progress" &&
                        task.runStatus !== "queued" &&
                        !task.waitingOn?.length
                      )
                        return "blue";
                      return undefined;
                    };
                    const lead = () =>
                      `${[
                        `#${entry().number}`,
                        entry().subtasks?.total ? undefined : owner(),
                      ]
                        .filter(Boolean)
                        .join(" · ")} · `;
                    return (
                      <View
                        role="button"
                        accessibilityLabel={entry().title}
                        onPress={() => props.onOpen(entry().id)}
                        activeStyle={{ backgroundColor: c().selectedSoft }}
                        style={{
                          ...row,
                          height: phoneRowHeight,
                          paddingLeft: space[16],
                          paddingRight: space[12],
                          borderBottomWidth: 1,
                          borderColor: c().border,
                          gap: space[12],
                        }}
                      >
                        <View
                          style={{ width: control.md, alignItems: "center" }}
                        >
                          <TaskGlyph
                            status={
                              group().name === "Running"
                                ? "in_progress"
                                : entry().status
                            }
                            size={icon.md}
                          />
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                          <Label lines={1}>{entry().title}</Label>
                          <Label
                            variant="caption"
                            lines={1}
                            tone={
                              entry().status === "blocked"
                                ? "mutedInk"
                                : "muted"
                            }
                          >
                            {lead()}
                            <Label
                              variant="caption"
                              tone={
                                stateTone() ??
                                (entry().status === "blocked"
                                  ? "mutedInk"
                                  : "muted")
                              }
                            >
                              {state()}
                            </Label>
                          </Label>
                        </View>
                        <PhoneRowEnd
                          task={entry()}
                          time={relativeTime(entry().updatedAt)}
                        />
                        <Icon name="right" size={icon.md} tone="muted" />
                      </View>
                    );
                  }}
                </Each>
                <If when={entries().length === 0}>
                  <View
                    style={{
                      ...row,
                      height: space[40],
                      paddingLeft: space[16],
                      paddingRight: space[12],
                      borderBottomWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label variant="small" tone="muted">
                      {uiText("noTasksInGroup", {
                        group: uiText(group().label),
                      })}
                    </Label>
                  </View>
                </If>
              </If>
            </If>
          );
        }}
      </Each>
    </SmoothScroll>
  );
}

/**
 * The end of a phone's (or a narrow tablet list's) row: its time, and under it what it used while
 * the setting is on. A run of eta's own loop that is going says tokens over its live rate instead.
 */
function PhoneRowEnd(props: { task: BoardTaskView; time: string }) {
  const usage = () => (usageShown() ? cardUsage(props.task) : undefined);
  const rate = useLiveRate(() =>
    usage() && !usage()!.withSubtasks
      ? usage()!.brief.liveSessionId
      : undefined,
  );
  return (
    <View style={{ alignItems: "flex-end", gap: space[2], flexShrink: 0 }}>
      <If
        when={rate()}
        else={
          <Label variant="caption" tone="muted">
            {props.time}
          </Label>
        }
      >
        <Label variant="caption" tone="mutedInk">
          {usageText(usage()!, {})}
        </Label>
      </If>
      <If when={usage()}>
        {(current) => (
          <If
            when={rate()}
            else={
              <Label
                variant="caption"
                tone={current().brief.tokens ? "mutedInk" : "faint"}
              >
                {current().brief.tokens
                  ? uiText("usageTok", {
                      count: tokens(current().brief.tokens!.total),
                    })
                  : uiText("usageNoDataShort")}
              </Label>
            }
          >
            {(value) => (
              <Label variant="caption" tone="green">
                {uiText("usageRate", { rate: value().toFixed(1) })}
              </Label>
            )}
          </If>
        )}
      </If>
    </View>
  );
}

/** The narrow list beside an open task on tablet: one flat row per task. */
export function TabletTaskList(props: {
  tasks: BoardTaskView[];
  selected?: string;
  onOpen: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const meta = (task: BoardTaskView) => {
    const owner = ownerLine(task, host.agent);
    if (task.subtasks?.total)
      return [
        `#${task.number}`,
        uiText("parentTaskProgress", task.subtasks),
      ].join(" · ");
    const state = () => {
      if (task.status === "in_review") return uiText("forYouToCheck2");
      if (task.status === "blocked") return uiText("taskNeedsDecision");
      if (task.status === "in_progress") return `■ ${runningFor(task)}`;
      if (task.status === "done") {
        const step = stepOf(task, host.tasks());
        return step ? uiText("step", { value1: step }) : statusName("done");
      }
      const wait = task.waitingOn?.[0];
      if (wait)
        return uiText("waitsForTask", {
          title: wait.title || `#${wait.number}`,
        });
      return statusName(task.status);
    };
    return [`#${task.number}`, owner, state()].filter(Boolean).join(" · ");
  };
  const tone = (task: BoardTaskView) =>
    task.subtasks?.total
      ? "muted"
      : task.status === "in_review"
        ? "warning"
        : task.status === "in_progress"
          ? "blue"
          : task.status === "blocked"
            ? "mutedInk"
            : "muted";
  const time = (task: BoardTaskView) =>
    task.status === "done" ||
    task.status === "cancelled" ||
    Date.now() - task.updatedAt >= 86_400_000
      ? taskDay(task.updatedAt)
      : relativeTime(task.updatedAt);
  return (
    <SmoothScroll style={grow} scrollbar={false}>
      <Each of={props.tasks} key={(task) => task.id}>
        {(task) => (
          <View
            role="button"
            accessibilityLabel={task().title}
            accessibilityState={{ selected: task().id === props.selected }}
            onPress={() => props.onOpen(task().id)}
            hoverStyle={{
              backgroundColor:
                task().id === props.selected ? c().selected : c().selectedSoft,
            }}
            activeStyle={{
              backgroundColor:
                task().id === props.selected ? c().selected : c().selectedSoft,
            }}
            style={{
              ...row,
              height: tabletRowHeight,
              paddingHorizontal: space[16],
              gap: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
              backgroundColor:
                task().id === props.selected ? c().selected : undefined,
              cursor: "pointer",
            }}
          >
            <TaskGlyph status={task().status} size={icon.md} />
            <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
              <Label variant="small" lines={1}>
                {task().title}
              </Label>
              <Label variant="caption" lines={1} tone={tone(task())}>
                {meta(task())}
              </Label>
            </View>
            <PhoneRowEnd task={task()} time={time(task())} />
          </View>
        )}
      </Each>
    </SmoothScroll>
  );
}

export function TaskTableRow(props: {
  item: BoardTaskView;
  layout: Layout;
  nested?: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  const host = useHost();
  const desktop = () => props.layout === "desktop";
  const phone = () => props.layout === "phone";
  const hint = () => {
    const task = props.item;
    if (task.status === "done") {
      const step = stepOf(task, host.tasks());
      return step ? uiText("step", { value1: step }) : statusName(task.status);
    }
    return taskHint(task, host.tasks()) ?? statusName(task.status);
  };
  const hintTone = () => {
    const status = props.item.status;
    if (status === "in_review") return "warning";
    if (status === "in_progress" && !props.item.subtasks?.total) return "blue";
    if (status === "todo" && !props.item.waitingOn?.length) return "ink";
    return status === "blocked" && !props.item.waitingOn?.length
      ? "red"
      : "mutedInk";
  };
  return (
    <View
      role="button"
      accessibilityLabel={props.item.title}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selectedSoft }}
      focusVisibleStyle={{ backgroundColor: c().selectedSoft }}
      style={{
        ...row,
        height: space[32],
        borderBottomWidth: 1,
        borderColor: c().border,
        // Nested under its parent's title: the row's inset, the glyph's column and its gap.
        paddingLeft: props.nested
          ? space[16] + (desktop() ? space[24] : space[12] + space[8])
          : space[16],
        paddingRight: space[16],
        gap: desktop() ? 0 : space[8],
        cursor: "pointer",
      }}
    >
      <View
        style={{ width: desktop() ? space[24] : phone() ? icon.md : icon.sm }}
      >
        <TaskGlyph
          status={props.item.status}
          size={phone() ? icon.md : icon.sm}
        />
      </View>
      <Label
        variant="caption"
        tone="muted"
        style={{
          width: desktop() ? columnWidth.number : columnWidth.numberTablet,
        }}
      >{`#${props.item.number}`}</Label>
      <Label variant="small" lines={1} style={{ flex: 1 }}>
        {props.item.title}
      </Label>
      <If when={usageShown() && !phone()}>
        <View
          style={{
            width: desktop() ? columnWidth.usage : columnWidth.usageTablet,
            paddingRight: space[12],
            flexShrink: 0,
          }}
        >
          <UsageLine
            task={props.item}
            model={desktop()}
            rate
            variant="caption"
          />
        </View>
      </If>
      <View
        style={{
          ...row,
          gap: space[4],
          width: phone()
            ? columnWidth.hintPhone
            : desktop()
              ? columnWidth.hint
              : props.nested
                ? columnWidth.hintNested
                : columnWidth.hintTablet,
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        <If
          when={
            props.item.status === "in_progress" && !props.item.subtasks?.total
          }
        >
          <View
            style={{
              width: dotSize,
              height: dotSize,
              backgroundColor: c().blue,
            }}
          />
        </If>
        <If when={isWaiting(props.item)}>
          <Icon name="lock" size={icon.sm} tone="mutedInk" />
        </If>
        <Label
          variant="caption"
          lines={1}
          tone={hintTone()}
          style={{ flexShrink: 1, minWidth: 0 }}
        >
          {hint()}
        </Label>
      </View>
      <If when={!phone()}>
        <Label
          variant="caption"
          tone="mutedInk"
          lines={1}
          style={{
            width: desktop() ? columnWidth.owner : columnWidth.ownerTablet,
          }}
        >
          {ownerLine(props.item, host.agent)}
        </Label>
        <Label
          variant="caption"
          tone="muted"
          lines={1}
          style={{
            width: desktop() ? columnWidth.time : columnWidth.timeTablet,
            textAlign: "right",
          }}
        >
          {phone() ? relativeTime(props.item.updatedAt) : taskTime(props.item)}
        </Label>
      </If>
    </View>
  );
}
