import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { clockDistance, runHistory, scheduleLabel } from "./schedule";

/** A row of the tablet's flush list. */
const tabletRowHeight = 60;

export function RoutineRow(props: {
  item: RoutineSummary;
  selected: boolean;
  paused: boolean;
  tablet?: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      onPress={props.onOpen}
      // Hover is the selected fill at half strength, so the open row still stands out.
      hoverStyle={{
        backgroundColor: props.selected ? c().selected : c().selectedSoft,
      }}
      style={{
        ...row,
        ...(props.tablet
          ? {
              height: tabletRowHeight,
              paddingHorizontal: space[16],
              gap: space[8],
            }
          : { padding: space[8], gap: space[16] }),
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : c().canvas,
      }}
    >
      <View
        style={{
          flex: 1,
          minWidth: 0,
          gap: props.tablet ? space[2] : space[4],
        }}
      >
        <Label
          weight={
            props.tablet && props.selected ? weight.strong : weight.regular
          }
          lines={1}
        >
          {props.item.name}
        </Label>
        <Label variant="small" tone="muted">
          {scheduleLabel(props.item.schedule)}
        </Label>
      </View>
      <View
        style={{
          alignItems: "flex-end",
          gap: space[4],
          flexShrink: 0,
        }}
      >
        <If when={!(props.tablet && props.paused)}>
          <View style={{ ...row, gap: 1 }}>
            <Each of={runHistory(props.item.runs)}>
              {(entry) => (
                <View
                  style={{
                    width: space[8],
                    height: space[8],
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
        <Label variant="small" tone="muted">
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
