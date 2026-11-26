import type { BriefView, RoutineInfo, RunView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  focusRing,
  grow,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { EarlierReportCard, LatestReportCard } from "./history";
import {
  clockDistance,
  clockTime,
  dayWord,
  scheduleFor,
  shortDate,
} from "./schedule";

/** The schedule and brief labels, and the time column of the timeline under them. */
const labelWidth = 72;

export function RoutineDetail(props: {
  routine: RoutineInfo;
  brief?: BriefView;
  firstBrief?: BriefView;
  layout: Layout;
  runs: RunView[];
  canRun: boolean;
  starting?: boolean;
  onRun: () => void;
  onReport: (id: string) => void;
  onReadBrief: () => void;
  onEdit: () => void;
  /** Dimmed when the connection cannot delete routines. */
  canDelete: boolean;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  const inset = () => (phone() ? space[16] : space[24]);
  const latest = () => props.runs.find((run) => run.status === "sent");
  const earlier = () => props.runs.filter((run) => run.id !== latest()?.id);
  // Two cards a row on the desktop, one on the narrower layouts.
  const earlierRows = () => {
    const perRow = props.layout === "desktop" ? 2 : 1;
    const rows: RunView[][] = [];
    for (let index = 0; index < earlier().length; index += perRow)
      rows.push(earlier().slice(index, index + perRow));
    return rows;
  };
  return (
    <View style={grow}>
      <If when={props.layout !== "phone"}>
        <View
          style={{
            paddingVertical: space[12],
            paddingHorizontal:
              props.layout === "desktop" ? space[32] : space[24],
            gap: space[4],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, height: space[24], gap: space[16] }}>
            <Label
              variant="subtitle"
              weight={weight.strong}
              style={{ flex: 1 }}
            >
              {props.routine.name}
            </Label>
            <View style={{ ...row, gap: space[8] }}>
              <ToggleSwitch
                label={
                  props.routine.enabled ? uiText("pause") : uiText("resume")
                }
                checked={props.routine.enabled}
                compact
                onChange={props.onToggle}
              />
              <Button
                label={uiText("runNow")}
                icon="play"
                iconSize={icon.md}
                iconOnly
                tone="ghost"
                disabled={!props.canRun}
                busy={props.starting}
                onPress={props.onRun}
              />
              <ActionMenu
                label={uiText("routineActions")}
                iconSize={icon.md}
                triggerStyle={{
                  minWidth: space[24],
                  width: space[24],
                  height: space[24],
                  paddingHorizontal: 0,
                }}
              >
                <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
                <ActionItem
                  label={uiText("deleteRoutineMenu")}
                  tone="red"
                  disabled={!props.canDelete}
                  onSelect={props.onDelete}
                />
              </ActionMenu>
            </View>
          </View>
          <View style={{ ...row, gap: space[12] }}>
            <Label variant="small" tone="muted" style={{ width: labelWidth }}>
              {uiText("schedule")}
            </Label>
            <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
              {scheduleFor(props.routine.schedule, props.routine.timezone)}
            </Label>
          </View>
          <View style={{ ...row, gap: space[12] }}>
            <Label variant="small" tone="muted" style={{ width: labelWidth }}>
              {uiText("briefV", {
                value1: props.brief?.version ?? 1,
              })}
            </Label>
            <Label
              variant="small"
              tone="mutedInk"
              lines={1}
              style={{ flex: 1 }}
            >
              {props.brief?.text ?? ""}
            </Label>
            <View
              role="button"
              accessibilityLabel={uiText("readBrief")}
              onPress={props.onReadBrief}
              focusVisibleStyle={focusRing(c(), "inset")}
              style={{ flexShrink: 0, cursor: "pointer" }}
            >
              <Label
                variant="small"
                style={{
                  textDecorationLine: "underline",
                  textDecorationThickness: 1,
                }}
              >
                {uiText("readBrief")}
              </Label>
            </View>
          </View>
        </View>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <If when={phone()}>
          <View
            style={{
              paddingVertical: space[12],
              paddingHorizontal: space[16],
              gap: space[4],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <View style={{ ...row, alignItems: "baseline", gap: space[12] }}>
              <Label variant="small" tone="muted" style={{ width: space[64] }}>
                {uiText("schedule")}
              </Label>
              <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
                {scheduleFor(props.routine.schedule, props.routine.timezone)}
              </Label>
            </View>
            <View style={{ ...row, alignItems: "baseline", gap: space[12] }}>
              <Label variant="small" tone="muted" style={{ width: space[64] }}>
                {uiText("briefV", { value1: props.brief?.version ?? 1 })}
              </Label>
              <Label lines={3} style={{ flex: 1 }}>
                {props.brief?.text ?? ""}
              </Label>
            </View>
          </View>
        </If>
        <View
          style={{
            ...row,
            ...(phone() ? { height: control.touch } : { minHeight: space[32] }),
            paddingHorizontal: inset(),
            gap: space[12],
          }}
        >
          <If when={phone() ? null : props.routine.nextRunAt}>
            {(at) => (
              <Label
                variant="small"
                tone="mutedInk"
                style={{ width: labelWidth, flexShrink: 0 }}
              >
                {clockTime(at())}
              </Label>
            )}
          </If>
          <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
            {props.routine.nextRunAt
              ? uiText("nextReportOn", {
                  // The phone has no time column, so the time joins the day.
                  day: phone()
                    ? `${dayWord(props.routine.nextRunAt!)} ${clockTime(props.routine.nextRunAt!)}`
                    : dayWord(props.routine.nextRunAt!),
                  clockDistance: clockDistance(props.routine.nextRunAt!),
                })
              : props.routine.enabled
                ? uiText("noUpcomingRun")
                : uiText("paused")}
          </Label>
          <Button
            label={uiText("runNow")}
            icon="play"
            tone="ghost"
            disabled={!props.canRun}
            busy={props.starting}
            style={{ gap: space[4], paddingHorizontal: 0 }}
            onPress={props.onRun}
          />
        </View>
        <If when={!props.runs.length}>
          <EmptyState
            size="row"
            status="empty"
            loading={null}
            error={null}
            empty={{
              title: props.routine.nextRunAt
                ? uiText("routineNoRunsYetNext", {
                    time: `${dayWord(props.routine.nextRunAt)} ${clockTime(props.routine.nextRunAt)}`,
                  })
                : uiText("routineNoRunsYet"),
            }}
            style={{
              paddingVertical: space[16],
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          />
        </If>
        <If when={latest()}>
          {(run) => (
            <View
              style={{
                paddingVertical: space[16],
                paddingHorizontal: inset(),
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <LatestReportCard
                run={run()}
                phone={phone()}
                onOpen={() => props.onReport(run().id)}
              />
            </View>
          )}
        </If>
        <If when={earlier().length}>
          <View
            style={{
              ...(phone()
                ? { padding: space[16], gap: space[12] }
                : {
                    paddingTop: space[8],
                    paddingBottom: space[16],
                    gap: space[8],
                  }),
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" tone="muted">
              {uiText("earlierReports")}
            </Label>
            <View
              style={{ gap: props.layout === "desktop" ? space[12] : space[8] }}
            >
              <Each of={earlierRows()} key={(cards) => cards[0]!.id}>
                {(cards) => (
                  <View
                    style={{ ...row, alignItems: "stretch", gap: space[12] }}
                  >
                    <Each of={cards()} key={(run) => run.id}>
                      {(run) => (
                        <EarlierReportCard
                          run={run()}
                          onOpen={() => props.onReport(run().id)}
                          onRetry={props.onRun}
                          canRetry={props.canRun}
                          compact={props.layout === "tablet"}
                        />
                      )}
                    </Each>
                    <If
                      when={cards().length === 1 && props.layout === "desktop"}
                    >
                      <View style={grow} />
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>
        <View
          style={{
            ...row,
            ...(phone()
              ? { height: control.touch, borderBottomWidth: 1 }
              : { minHeight: space[32] }),
            paddingHorizontal: inset(),
            gap: space[12],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={!phone()}>
            <Label
              variant="small"
              tone="muted"
              style={{ width: labelWidth, flexShrink: 0 }}
            >
              {shortDate(props.routine.createdAt)}
            </Label>
          </If>
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {uiText("routineCreatedMarker", {
              version: props.firstBrief?.version ?? 1,
              date: shortDate(props.routine.createdAt),
            })}
          </Label>
        </View>
      </SmoothScroll>
    </View>
  );
}
