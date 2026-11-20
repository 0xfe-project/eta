import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { clockDistance, runHistory, scheduleLabel } from "./schedule";

export function RoutineRow(props: {
  item: RoutineSummary;
  selected: boolean;
  paused: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        paddingHorizontal: 20,
        minHeight: 52,
        borderColor: c().border,
        justifyContent: "space-between",
        gap: 6,
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : c().canvas,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Label lines={1}>{props.item.name}</Label>
        <Label size={12} tone="muted">
          {scheduleLabel(props.item.schedule)}
        </Label>
      </View>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <View style={{ ...row, gap: 3 }}>
          <Each of={runHistory(props.item.runs)}>
            {(entry) => (
              <StatusDot
                color={
                  entry() === "failed"
                    ? c().red
                    : entry() === "running"
                      ? c().blue
                      : entry() === "sent"
                        ? c().ink
                        : c().border
                }
                size={7}
              />
            )}
          </Each>
        </View>
        <Label size={12} tone="muted">
          {props.paused
            ? uiText("captainIsOff")
            : !props.item.enabled
              ? uiText("paused")
              : props.item.nextRunAt
                ? uiText("nextWithCount", {
                    clockDistance: clockDistance(props.item.nextRunAt!),
                  })
                : uiText("noUpcomingRun")}
        </Label>
      </View>
    </View>
  );
}
