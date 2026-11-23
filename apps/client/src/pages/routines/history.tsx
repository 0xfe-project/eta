import type { RoutineSummary, RunView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, row } from "../../components";
import { chatText, shownMentions } from "../../components/eta-editor";
import { StatusDot } from "../../components/status-dot";
import { weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useAgentMentions } from "../../services/agent-mentions";
import { clockDistance, feedTime, runHistory, scheduleLabel } from "./schedule";

export function RoutineHistory(props: {
  runs: RoutineSummary["runs"];
  full?: boolean;
}) {
  const c = colors();
  return (
    <View style={{ ...row, gap: props.full ? 4 : 2, flexShrink: 0 }}>
      <Each of={runHistory(props.runs)} key="index">
        {(status) => (
          <View
            style={{
              ...(props.full
                ? { flex: 1, height: 8 }
                : { width: 8, height: 8 }),
              backgroundColor:
                status() === "failed"
                  ? c().red
                  : status() === "running"
                    ? c().blue
                    : status() === "sent" || status() === "no_news"
                      ? c().ink
                      : c().border,
            }}
          />
        )}
      </Each>
    </View>
  );
}

export function PhoneRoutineRow(props: {
  item: RoutineSummary;
  paused: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  const failed = () => props.item.runs[0]?.status === "failed";
  const status = () =>
    props.paused
      ? uiText("captainIsOff")
      : !props.item.enabled
        ? uiText("paused")
        : props.item.nextRunAt
          ? uiText("nextWithCount", {
              clockDistance: clockDistance(props.item.nextRunAt!),
            })
          : uiText("noUpcomingRun");

  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      accessibilityDescription={`${scheduleLabel(props.item.schedule)} · ${status()}`}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      style={{
        ...row,
        paddingVertical: 12,
        paddingLeft: 16,
        paddingRight: 12,
        gap: 12,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3, paddingBottom: 6 }}>
        <View style={{ ...row, gap: 8 }}>
          <Label lines={1} style={{ flex: 1, minWidth: 0 }}>
            {props.item.name}
          </Label>
          <If when={!props.paused}>
            <RoutineHistory runs={props.item.runs} />
          </If>
        </View>
        <View style={{ ...row, gap: 8 }}>
          <Label
            variant="caption"
            tone="muted"
            lines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {scheduleLabel(props.item.schedule)}
          </Label>
          <Label
            variant="caption"
            tone={props.paused ? "warningInk" : "muted"}
            lines={1}
          >
            {status()}
          </Label>
        </View>
      </View>
      <If
        when={props.item.unseenFailures || failed() || props.item.unseenReports}
      >
        <StatusDot
          color={props.item.unseenFailures || failed() ? c().red : c().blue}
        />
      </If>
      <Icon name="right" size={14} />
    </View>
  );
}

function runTitle(run: RunView) {
  return run.status === "sent"
    ? (run.title ?? uiText("report"))
    : run.status === "running"
      ? uiText("running")
      : uiText("noReport");
}

/** The report without a first heading that only repeats its title, which is shown above it. */
export function reportBody(run: RunView) {
  const report = run.report ?? "";
  const heading = /^#{1,6}\s+(.+)\n*/.exec(report);
  return heading && heading[1]!.trim() === run.title?.trim()
    ? report.slice(heading[0].length)
    : report;
}

/** The newest report, in full, at the top of a routine's feed. */
export function LatestReportCard(props: {
  run: RunView;
  /** The phone shows the whole report in a tighter card. */
  phone?: boolean;
  onOpen: () => void;
}) {
  const agentMentions = useAgentMentions();
  const c = colors();
  const inset = () => (props.phone ? 12 : 16);
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View style={{ padding: inset(), gap: 6 }}>
        <Label variant="small" tone="muted">
          {feedTime(props.run.startedAt)}
        </Label>
        <View style={{ gap: 8 }}>
          <Label variant="subtitle" weight={weight.strong}>
            {runTitle(props.run)}
          </Label>
          <If when={props.run.report}>
            <View
              style={
                props.phone ? undefined : { maxHeight: 280, overflow: "hidden" }
              }
            >
              <chatText.View
                plugins={[shownMentions()]}
                text={{
                  text: reportBody(props.run),
                  mentions: agentMentions(),
                }}
                label={runTitle(props.run)}
              />
            </View>
          </If>
        </View>
      </View>
      <View
        style={{
          ...row,
          height: 32,
          paddingHorizontal: inset(),
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <View
          role="button"
          accessibilityLabel={uiText("readReport")}
          onPress={props.onOpen}
          focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
          style={{ ...row, gap: 6, cursor: "pointer" }}
        >
          <Label variant="small" weight={weight.strong}>
            {uiText("readReport")}
          </Label>
          <Icon name="arrowRight" size={12} />
        </View>
      </View>
    </View>
  );
}

/** One of the earlier reports: its title and the start of it, or why there is none. */
export function EarlierReportCard(props: {
  run: RunView;
  canRetry: boolean;
  /** One full-width card a row: a missed run on one line, the summary unclipped. */
  compact?: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const c = colors();
  const retry = () => (
    <If when={props.run.status === "failed"}>
      <View
        role="button"
        accessibilityLabel={uiText("retry")}
        accessibilityState={{ disabled: !props.canRetry }}
        onPress={() => {
          if (props.canRetry) props.onRetry();
        }}
        style={{
          alignSelf: props.compact ? undefined : "flex-start",
          flexShrink: 0,
          cursor: props.canRetry ? "pointer" : "default",
        }}
      >
        <Label variant="small" tone={props.canRetry ? "mutedInk" : "faint"}>
          {uiText("retry")}
        </Label>
      </View>
    </If>
  );
  const missed = () =>
    props.run.status === "failed" || props.run.status === "skipped";
  const summary = () =>
    reportBody(props.run)
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .find((part) => part && !part.startsWith("#")) ?? "";
  return (
    <View
      role="button"
      accessibilityLabel={runTitle(props.run)}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().surface }}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      style={{
        flex: 1,
        minWidth: 0,
        gap: props.compact && missed() ? 2 : 4,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
        height: missed() && !props.compact ? 110 : undefined,
      }}
    >
      <Label variant="small" tone="muted">
        {feedTime(props.run.startedAt)}
      </Label>
      <If
        when={missed()}
        else={
          <>
            <Label weight={weight.strong} lines={1}>
              {runTitle(props.run)}
            </Label>
            <Label
              lines={props.compact ? undefined : 2}
              style={props.compact ? undefined : { height: 44 }}
            >
              {summary()}
            </Label>
          </>
        }
      >
        <If when={props.compact}>
          <View style={{ ...row, gap: 8 }}>
            <StatusDot color={c().red} />
            <Label weight={weight.strong} tone="muted">
              {uiText("noReport")}
            </Label>
            <Label tone="muted" lines={1} style={{ flex: 1, minWidth: 0 }}>
              {props.run.error ?? ""}
            </Label>
            {retry()}
          </View>
        </If>
        <If when={!props.compact}>
          <View style={{ ...row, gap: 8 }}>
            <StatusDot color={c().red} />
            <Label weight={weight.strong} tone="muted">
              {uiText("noReport")}
            </Label>
          </View>
          <Label tone="muted" lines={1} style={{ flex: 1 }}>
            {props.run.error ?? ""}
          </Label>
          {retry()}
        </If>
      </If>
    </View>
  );
}
