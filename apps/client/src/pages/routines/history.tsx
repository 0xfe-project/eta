import type { RoutineSummary, RunView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label, Markdown, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { localizedText, uiText } from "../../i18n";
import { feedTime, mobileSchedule, runAgo, runHistory } from "./schedule";

export function RoutineHistory(props: {
  runs: RoutineSummary["runs"];
  full?: boolean;
}) {
  const c = colors();
  return (
    <View style={{ ...row, gap: 4 }}>
      <Each of={runHistory(props.runs)} key="index">
        {(status) => (
          <View
            style={{
              ...(props.full
                ? { flex: 1, height: 8 }
                : { width: 13, height: 6 }),
              backgroundColor:
                status() === "failed"
                  ? c().red
                  : status() === "running"
                    ? c().blue
                    : status() === "sent" || status() === "no_news"
                      ? c().green
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
  const recent = () => props.item.runs[0];
  const failed = () => recent()?.status === "failed";
  const details = () =>
    [
      mobileSchedule(props.item.schedule),
      props.paused
        ? uiText("captainIsOff")
        : !props.item.enabled
          ? uiText("paused")
          : failed()
            ? localizedText("last run failed", "上次运行失败")
            : recent()?.status === "running"
              ? uiText("running")
              : recent()?.status === "skipped"
                ? localizedText("last run skipped", "上次运行已跳过")
                : recent()
                  ? localizedText(
                      `ran ${runAgo(recent()!.startedAt)}`,
                      `${runAgo(recent()!.startedAt)}运行`,
                    )
                  : undefined,
      props.item.unseenReports
        ? localizedText(
            `${props.item.unseenReports} new ${props.item.unseenReports === 1 ? "report" : "reports"}`,
            `${props.item.unseenReports} 份新报告`,
          )
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      accessibilityDescription={details()}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      style={{
        ...row,
        minHeight: 76,
        paddingHorizontal: 16,
        gap: 14,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Label lines={1} line={20}>
          {props.item.name}
        </Label>
        <Label size={11} lines={1} line={14} tone={failed() ? "ink" : "muted"}>
          {details()}
        </Label>
        <RoutineHistory runs={props.item.runs} />
      </View>
      <If
        when={props.item.unseenFailures || failed() || props.item.unseenReports}
      >
        <StatusDot
          color={props.item.unseenFailures || failed() ? c().red : c().blue}
        />
      </If>
      <Icon name="right" size={10} tone="muted" />
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
export function LatestReportCard(props: { run: RunView; onOpen: () => void }) {
  const c = colors();
  return (
    <View style={{ borderWidth: 1, borderColor: c().border }}>
      <View style={{ padding: 16, gap: 6 }}>
        <Label size={12} line={16} tone="muted">
          {feedTime(props.run.startedAt)}
        </Label>
        <View style={{ gap: 8 }}>
          <Label size={16} line={22} weight={600}>
            {runTitle(props.run)}
          </Label>
          <If when={props.run.report}>
            <View style={{ maxHeight: 280, overflow: "hidden" }}>
              <Markdown value={reportBody(props.run)} line={22} />
            </View>
          </If>
        </View>
      </View>
      <View
        style={{
          ...row,
          height: 32,
          paddingHorizontal: 16,
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
          <Label size={12} line={16} weight={600}>
            {uiText("readReport")}
          </Label>
          <Icon name="right" size={12} />
        </View>
      </View>
    </View>
  );
}

/** One of the earlier reports: its title and the start of it, or why there is none. */
export function EarlierReportCard(props: {
  run: RunView;
  canRetry: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const c = colors();
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
        gap: 4,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
        height: missed() ? 110 : undefined,
      }}
    >
      <Label size={12} line={16} tone="muted">
        {feedTime(props.run.startedAt)}
      </Label>
      <If
        when={missed()}
        else={
          <>
            <Label size={14} line={20} weight={600} lines={1}>
              {runTitle(props.run)}
            </Label>
            <Label size={14} line={22} lines={2} style={{ height: 44 }}>
              {summary()}
            </Label>
          </>
        }
      >
        <View style={{ ...row, gap: 8 }}>
          <StatusDot color={c().red} />
          <Label size={14} line={20} weight={600} tone="muted">
            {uiText("noReport")}
          </Label>
        </View>
        <Label size={14} line={22} tone="muted" lines={1} style={{ flex: 1 }}>
          {props.run.error ?? ""}
        </Label>
        <If when={props.run.status === "failed"}>
          <View
            role="button"
            accessibilityLabel={uiText("retry")}
            accessibilityState={{ disabled: !props.canRetry }}
            onPress={() => {
              if (props.canRetry) props.onRetry();
            }}
            style={{
              alignSelf: "flex-start",
              cursor: props.canRetry ? "pointer" : "default",
            }}
          >
            <Label
              size={12}
              line={16}
              tone={props.canRetry ? "mutedInk" : "faint"}
            >
              {uiText("retry")}
            </Label>
          </View>
        </If>
      </If>
    </View>
  );
}
