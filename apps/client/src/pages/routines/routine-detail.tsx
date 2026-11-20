import type { BriefView, RoutineInfo, RunView } from "@eta/client-contracts";
import type { Layout } from "../../components";
import { Scroll, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  grow,
  Label,
  row,
} from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { EarlierReportCard, LatestReportCard } from "./history";
import {
  clockDistance,
  clockTime,
  dayWord,
  scheduleFor,
  shortDate,
} from "./schedule";

export function RoutineDetail(props: {
  routine: RoutineInfo;
  brief?: BriefView;
  firstBrief?: BriefView;
  layout: Layout;
  runs: RunView[];
  canRun: boolean;
  onRun: () => void;
  onReport: (id: string) => void;
  onReadBrief: () => void;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const c = colors();
  const inset = () => (props.layout === "phone" ? 16 : 24);
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
            paddingVertical: 12,
            paddingHorizontal: 32,
            gap: 4,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, height: 24, gap: 16 }}>
            <Label size={16} line={24} weight={600} style={{ flex: 1 }}>
              {props.routine.name}
            </Label>
            <View style={{ ...row, gap: 8 }}>
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
                icon="right"
                iconOnly
                tone="ghost"
                disabled={!props.canRun}
                onPress={props.onRun}
              />
              <ActionMenu
                label={uiText("routineActions")}
                triggerStyle={{
                  minWidth: 24,
                  width: 24,
                  height: 24,
                  paddingHorizontal: 0,
                }}
              >
                <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
              </ActionMenu>
            </View>
          </View>
          <View style={{ ...row, gap: 12 }}>
            <Label size={12} line={16} tone="muted" style={{ width: 72 }}>
              {uiText("schedule")}
            </Label>
            <Label size={12} line={16} tone="mutedInk" style={{ flex: 1 }}>
              {scheduleFor(props.routine.schedule, props.routine.timezone)}
            </Label>
          </View>
          <View style={{ ...row, gap: 12 }}>
            <Label size={12} line={16} tone="muted" style={{ width: 72 }}>
              {uiText("briefV", {
                value1: props.brief?.version ?? 1,
              })}
            </Label>
            <Label
              size={12}
              line={16}
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
              focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
              style={{ flexShrink: 0, cursor: "pointer" }}
            >
              <Label
                size={12}
                line={16}
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
      <Scroll style={grow} scrollbar={false}>
        <View
          style={{
            ...row,
            minHeight: 32,
            paddingHorizontal: inset(),
            gap: 12,
          }}
        >
          <If when={props.routine.nextRunAt}>
            {(at) => (
              <Label
                size={12}
                line={16}
                tone="mutedInk"
                style={{ width: 72, flexShrink: 0 }}
              >
                {clockTime(at())}
              </Label>
            )}
          </If>
          <Label size={12} line={16} tone="mutedInk" style={{ flex: 1 }}>
            {props.routine.nextRunAt
              ? uiText("nextReportOn", {
                  day: dayWord(props.routine.nextRunAt!),
                  clockDistance: clockDistance(props.routine.nextRunAt!),
                })
              : props.routine.enabled
                ? uiText("noUpcomingRun")
                : uiText("paused")}
          </Label>
          <Button
            label={uiText("runNow")}
            icon="right"
            tone="ghost"
            disabled={!props.canRun}
            style={{ gap: 6, paddingHorizontal: 0 }}
            onPress={props.onRun}
          />
        </View>
        <If when={latest()}>
          {(run) => (
            <View
              style={{
                paddingVertical: 16,
                paddingHorizontal: inset(),
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <LatestReportCard
                run={run()}
                onOpen={() => props.onReport(run().id)}
              />
            </View>
          )}
        </If>
        <If when={earlier().length}>
          <View
            style={{
              paddingTop: 8,
              paddingBottom: 16,
              paddingHorizontal: inset(),
              gap: 8,
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label size={12} line={16} tone="muted">
              {uiText("earlierReports")}
            </Label>
            <View style={{ gap: 12 }}>
              <Each of={earlierRows()} key={(cards) => cards[0]!.id}>
                {(cards) => (
                  <View style={{ ...row, alignItems: "stretch", gap: 12 }}>
                    <Each of={cards()} key={(run) => run.id}>
                      {(run) => (
                        <EarlierReportCard
                          run={run()}
                          onOpen={() => props.onReport(run().id)}
                          onRetry={props.onRun}
                          canRetry={props.canRun}
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
        <If when={!props.runs.length}>
          <View
            style={{
              paddingVertical: 16,
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label tone="muted">{uiText("noReportsYet")}</Label>
          </View>
        </If>
        <View
          style={{
            ...row,
            minHeight: 32,
            paddingHorizontal: inset(),
            gap: 12,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label
            size={12}
            line={16}
            tone="muted"
            style={{ width: 72, flexShrink: 0 }}
          >
            {shortDate(props.routine.createdAt)}
          </Label>
          <Label size={12} line={16} tone="muted" style={{ flex: 1 }}>
            {uiText("routineCreatedMarker", {
              version: props.firstBrief?.version ?? 1,
              date: shortDate(props.routine.createdAt),
            })}
          </Label>
        </View>
      </Scroll>
    </View>
  );
}
