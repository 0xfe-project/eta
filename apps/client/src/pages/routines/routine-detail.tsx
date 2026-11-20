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
import { uiText } from "../../i18n";
import { RoutineFeedCard } from "./history";
import { clockDistance, routineTime, scheduleLabel } from "./schedule";

export function RoutineDetail(props: {
  routine: RoutineInfo;
  brief?: BriefView;
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
  const latest = () => props.runs.find((run) => run.status === "sent");
  return (
    <View style={grow}>
      <If when={props.layout !== "phone"}>
        <View
          style={{
            paddingVertical: 10,
            paddingHorizontal: 24,
            gap: 4,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, gap: 8 }}>
            <Label size={16} weight={600} style={{ flex: 1 }}>
              {props.routine.name}
            </Label>
            <Button
              label={props.routine.enabled ? uiText("pause") : uiText("resume")}
              onPress={props.onToggle}
            />
            <ActionMenu label={uiText("routineActions")}>
              <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
            </ActionMenu>
          </View>
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted" style={{ width: 76 }}>
              {uiText("schedule")}
            </Label>
            <Label
              size={12}
              tone="muted"
            >{`${scheduleLabel(props.routine.schedule)} · ${props.routine.timezone}`}</Label>
          </View>
          <View style={{ ...row, gap: 8 }}>
            <Label size={12} tone="muted" style={{ width: 76 }}>
              {uiText("briefV", {
                value1: props.brief?.version ?? 1,
              })}
            </Label>
            <Label size={12} tone="muted" lines={1} style={{ flex: 1 }}>
              {props.brief?.text ?? ""}
            </Label>
            <Button
              label={uiText("readBrief")}
              tone="ghost"
              onPress={props.onReadBrief}
            />
            <Button
              label={uiText("edit")}
              tone="ghost"
              onPress={props.onEdit}
            />
          </View>
        </View>
      </If>
      <View
        style={{
          ...row,
          minHeight: 44,
          paddingHorizontal: 16,
          gap: 8,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <Label size={12} tone="muted" style={{ flex: 1 }}>
          {props.routine.nextRunAt
            ? uiText("nextReport", {
                routineTime: routineTime(props.routine.nextRunAt!),
                clockDistance: clockDistance(props.routine.nextRunAt!),
              })
            : props.routine.enabled
              ? uiText("noUpcomingRun")
              : uiText("paused")}
        </Label>
        <Button
          label={uiText("runNow")}
          tone="ghost"
          disabled={!props.canRun}
          onPress={props.onRun}
        />
      </View>
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: props.layout === "phone" ? 16 : 24, gap: 10 }}>
          <If
            when={latest()}
            else={<Label tone="muted">{uiText("noReportsYet")}</Label>}
          >
            {(run) => (
              <RoutineFeedCard
                run={run()}
                latest
                onOpen={() => props.onReport(run().id)}
                onRetry={props.onRun}
                canRetry={props.canRun}
              />
            )}
          </If>
          <If when={props.runs.some((run) => run.id !== latest()?.id)}>
            <Label size={12} tone="muted" style={{ paddingTop: 12 }}>
              {uiText("earlierReports")}
            </Label>
            <View
              style={{
                flexDirection: props.layout === "desktop" ? "row" : "column",
                flexWrap: "wrap",
                gap: 10,
              }}
            >
              <Each
                of={props.runs.filter((run) => run.id !== latest()?.id)}
                key={(run) => run.id}
              >
                {(run) => (
                  <View
                    style={{
                      flexBasis: props.layout === "desktop" ? "48%" : undefined,
                      flexGrow: 1,
                    }}
                  >
                    <RoutineFeedCard
                      run={run()}
                      onOpen={() => props.onReport(run().id)}
                      onRetry={props.onRun}
                      canRetry={props.canRun}
                    />
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}
