import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { uiText } from "../../i18n";
import { clockDistance, runHistory, scheduleLabel } from "./schedule";

export function RoutineRow(props: {
  item: RoutineSummary;
  selected: boolean;
  paused: boolean;
  tablet?: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  // The tablet list is a flush column of 60px rows with smaller type.
  const small = () => (props.tablet ? 11 : 12);
  const smallLine = () => (props.tablet ? 14 : 16);
  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      onPress={props.onOpen}
      // Hover is the selected fill at 60%, so the open row still stands out.
      hoverStyle={{
        backgroundColor: props.selected ? c().selected : `${c().selected}99`,
      }}
      style={{
        ...row,
        ...(props.tablet
          ? { height: 60, paddingHorizontal: 14, gap: 10 }
          : { padding: 7, gap: 16 }),
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : c().canvas,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: props.tablet ? 3 : 4 }}>
        <Label
          size={props.tablet ? 13 : 14}
          line={18}
          weight={props.tablet && props.selected ? 600 : 400}
          lines={1}
        >
          {props.item.name}
        </Label>
        <Label size={small()} line={smallLine()} tone="muted">
          {scheduleLabel(props.item.schedule)}
        </Label>
      </View>
      <View
        style={{
          alignItems: "flex-end",
          gap: props.tablet ? 5 : 4,
          flexShrink: 0,
        }}
      >
        <If when={!(props.tablet && props.paused)}>
          <View style={{ ...row, gap: 1 }}>
            <Each of={runHistory(props.item.runs)}>
              {(entry) => (
                <View
                  style={{
                    width: props.tablet ? 9 : 8,
                    height: 8,
                    backgroundColor:
                      entry() === "failed"
                        ? c().red
                        : entry() === "running"
                          ? c().blue
                          : entry() === "sent"
                            ? c().ink
                            : props.tablet
                              ? c().border
                              : c().selected,
                  }}
                />
              )}
            </Each>
          </View>
        </If>
        <Label size={small()} line={smallLine()} tone="muted">
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
