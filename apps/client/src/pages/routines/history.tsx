import type { RoutineSummary, RunView } from "@eta/client-contracts";
import { View } from "nsh";
import { Button, colors, Icon, Label, Markdown, row } from "../../components";
import { StatusDot } from "../../components/status-dot";
import { localizedText, uiText } from "../../i18n";
import { mobileSchedule, routineTime, runAgo, runHistory } from "./schedule";

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

export function RoutineFeedCard(props: {
  run: RunView;
  latest?: boolean;
  canRetry: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const c = colors();
  const sent = () => props.run.status === "sent";
  const failed = () => props.run.status === "failed";
  return (
    <View style={{ borderWidth: 1, borderColor: c().border, gap: 6 }}>
      <View style={{ padding: 12, gap: 5 }}>
        <Label size={12} tone="muted">
          {routineTime(props.run.startedAt)}
        </Label>
        <View style={{ ...row, gap: 6 }}>
          <If when={failed()}>
            <StatusDot color={c().red} />
          </If>
          <Label
            size={sent() ? 16 : 14}
            weight={600}
            tone={sent() ? "ink" : "muted"}
          >
            {sent()
              ? (props.run.title ?? uiText("report"))
              : props.run.status === "running"
                ? uiText("running")
                : uiText("noReport")}
          </Label>
        </View>
        <If when={props.latest && props.run.report}>
          <View style={{ maxHeight: 280, overflow: "hidden" }}>
            <Markdown value={props.run.report ?? ""} line={22} />
          </View>
        </If>
        <If when={props.run.error}>
          <Label size={12} tone="muted">
            {props.run.error}
          </Label>
        </If>
      </View>
      <View
        style={{
          ...row,
          borderTopWidth: 1,
          borderColor: c().border,
          paddingHorizontal: 8,
        }}
      >
        <Button
          label={sent() ? uiText("readReport") : uiText("runDetails")}
          size={30}
          tone="ghost"
          end="right"
          onPress={props.onOpen}
        />
        <If when={failed()}>
          <Button
            label={uiText("retry")}
            size={30}
            tone="ghost"
            disabled={!props.canRetry}
            onPress={props.onRetry}
          />
        </If>
      </View>
    </View>
  );
}
