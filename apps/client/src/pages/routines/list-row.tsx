import type { RoutineSummary } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { Badge } from "../../ui";
import {
  clockDistance,
  runAgo,
  runHistory,
  scheduleLabel,
  triggerModeLabel,
  triggerStatusMeta,
  triggerTargetLabel,
} from "./schedule";

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
  const trigger = () => props.item.trigger ?? null;
  const rightStatus = () => {
    if (props.paused) return uiText("captainIsOff");
    if (!props.item.enabled) return uiText("paused");
    if (props.item.nextRunAt) {
      return uiText("nextWithCount", {
        clockDistance: clockDistance(props.item.nextRunAt),
      });
    }
    const activeTrigger = trigger();
    if (props.item.schedule === null && activeTrigger) {
      if (activeTrigger.status === "error")
        return uiText("triggerErrorSummary");
      if (activeTrigger.status === "disabled")
        return uiText("triggerStatusDisabled");
      if (activeTrigger.lastEventAt) {
        return uiText("triggerLastEvent", {
          ago: runAgo(activeTrigger.lastEventAt),
        });
      }
      return uiText("triggerListeningShort");
    }
    return uiText("noUpcomingRun");
  };
  const rightTone = () =>
    !props.paused &&
    props.item.enabled &&
    props.item.schedule === null &&
    trigger()?.status === "error"
      ? ("red" as const)
      : ("muted" as const);
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
        ...(props.tablet
          ? {
              minHeight: tabletRowHeight,
              paddingVertical: space[8],
              paddingHorizontal: space[16],
              gap: space[4],
            }
          : { padding: space[8], gap: space[4] }),
        cursor: "pointer",
        backgroundColor: props.selected ? c().selected : c().canvas,
      }}
    >
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: props.tablet ? space[8] : space[16],
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
          <If
            when={props.item.schedule !== null}
            else={
              <If when={trigger()}>
                {(entry) => (
                  <View
                    style={{
                      ...row,
                      gap: space[4],
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <If
                      when={triggerModeLabel(
                        entry().mode,
                        entry().pollingIntervalMinutes,
                      )}
                    >
                      {(modeText) => (
                        <Badge
                          label={modeText()}
                          tone="neutral"
                          size="caption"
                        />
                      )}
                    </If>
                    <Badge
                      label={triggerStatusMeta(entry().status).label}
                      tone={triggerStatusMeta(entry().status).tone}
                      size="caption"
                    />
                  </View>
                )}
              </If>
            }
          >
            <Label variant="small" tone="muted" lines={1}>
              {scheduleLabel(props.item.schedule)}
            </Label>
          </If>
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
          <Label variant="small" tone={rightTone()} lines={1}>
            {rightStatus()}
          </Label>
        </View>
      </View>
      <If when={trigger()}>
        {(entry) => (
          <View style={{ gap: space[2] }}>
            <View
              style={{
                ...row,
                gap: space[4],
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <Label
                variant="small"
                tone="muted"
                lines={1}
                style={{ flexShrink: 1, minWidth: 0 }}
              >
                {triggerTargetLabel(entry())}
              </Label>
              <If when={props.item.schedule !== null}>
                <If
                  when={triggerModeLabel(
                    entry().mode,
                    entry().pollingIntervalMinutes,
                  )}
                >
                  {(modeText) => (
                    <Badge label={modeText()} tone="neutral" size="caption" />
                  )}
                </If>
                <Badge
                  label={triggerStatusMeta(entry().status).label}
                  tone={triggerStatusMeta(entry().status).tone}
                  size="caption"
                />
              </If>
            </View>
            <If when={entry().fallbackReason}>
              {(reason) => (
                <Label variant="caption" tone="warningInk" lines={2}>
                  {uiText("triggerFallbackNotice", { reason: reason() })}
                </Label>
              )}
            </If>
            <If when={entry().status === "error" && entry().lastError}>
              {(err) => (
                <Label variant="caption" tone="red" lines={2}>
                  {err()}
                </Label>
              )}
            </If>
          </View>
        )}
      </If>
    </View>
  );
}
