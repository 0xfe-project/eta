import type { RoutineInfo, RunView } from "@eta/client-contracts";
import { Scroll, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Field,
  grow,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
} from "../../components";
import { formatLocale, localizedText, uiText } from "../../i18n";
import { RoutineHistory } from "./history";
import { mobileSchedule, routineTime, runAgo } from "./schedule";

interface RoutineReportProps {
  routine: RoutineInfo;
  run: RunView;
  index: number;
  count: number;
  phone: boolean;
  runs: RunView[];
  onBack: () => void;
  onMove: (by: number) => void;
  canRetry: boolean;
  onRetry: () => void;
  onToggle: () => void;
  onEdit: () => void;
  feedback: string;
  onFeedback: (value: string) => void;
  onSend: () => void;
}

function runDay(at: number) {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString())
    return localizedText("Today", "今天");
  return date.toLocaleDateString(formatLocale(), {
    month: "short",
    day: "numeric",
  });
}

function recordedDuration(run: RunView) {
  if (
    run.finishedAt === null ||
    run.finishedAt < run.startedAt ||
    run.status === "skipped"
  )
    return undefined;
  const duration = run.finishedAt - run.startedAt;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  if (seconds < 1) return localizedText(`${duration}ms`, `${duration}毫秒`);
  if (!minutes) return localizedText(`${seconds}s`, `${seconds}秒`);
  return localizedText(
    `${minutes}m ${seconds % 60}s`,
    `${minutes}分${seconds % 60}秒`,
  );
}

function PhoneRoutineFailure(props: RoutineReportProps) {
  const c = colors();
  const previousIndex = () =>
    props.runs.findIndex(
      (run, index) =>
        index > props.index && run.status === "sent" && Boolean(run.report),
    );
  const previous = () => props.runs[previousIndex()];
  const recent = () => props.runs.slice(0, 7);
  const time = () =>
    new Date(props.run.startedAt).toLocaleTimeString(formatLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const status = () =>
    props.run.status === "skipped"
      ? localizedText("Skipped", "已跳过")
      : uiText("failed");
  const error = () =>
    props.run.error ??
    (props.run.status === "skipped"
      ? uiText("theRoutineWasSkipped")
      : localizedText(
          "The routine failed without an error message.",
          "例行任务运行失败，未返回错误详情。",
        ));
  const schedule = () =>
    [
      mobileSchedule(props.routine.schedule),
      props.run.status === "skipped"
        ? undefined
        : localizedText("run by Captain", "由 Captain 运行"),
    ]
      .filter(Boolean)
      .join(" · ");
  const duration = () => {
    const elapsed = recordedDuration(props.run);
    return elapsed
      ? localizedText(`took ${elapsed}`, `耗时 ${elapsed}`)
      : undefined;
  };

  return (
    <Modal
      title={props.routine.name}
      phone
      phonePage
      overPhoneNavigation
      height="100%"
      onClose={props.onBack}
      headerActions={
        <ActionMenu label={uiText("routineActions")}>
          <If when={props.index > 0}>
            <ActionItem
              label={uiText("newer")}
              onSelect={() => props.onMove(-1)}
            />
          </If>
          <ActionItem
            label={props.routine.enabled ? uiText("pause") : uiText("resume")}
            onSelect={props.onToggle}
          />
          <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
        </ActionMenu>
      }
    >
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: 16, gap: 18 }}>
          <View style={{ gap: 8 }}>
            <View style={{ ...row, gap: 8 }}>
              <View
                style={{
                  height: 18,
                  paddingHorizontal: 8,
                  justifyContent: "center",
                  backgroundColor: c().button,
                }}
              >
                <Label
                  size={10}
                  tone="buttonInk"
                  style={{ textTransform: "uppercase", letterSpacing: 0.4 }}
                >
                  {status()}
                </Label>
              </View>
              <Label size={11} tone="muted">
                {[`${runDay(props.run.startedAt)} ${time()}`, duration()]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            </View>
            <Label size={11} tone="muted">
              {schedule()}
            </Label>
          </View>
          <View style={{ gap: 6 }}>
            <Caption text={uiText("report")} />
            <Label line={22}>{error()}</Label>
            <If when={previous()}>
              {(run) => (
                <Markdown
                  line={22}
                  value={localizedText(
                    `Last good run (${runAgo(run().startedAt)}): ${
                      run()
                        .report?.split(/\n\s*\n/)[0]
                        ?.trim() ?? ""
                    }`,
                    `上次成功运行（${runAgo(run().startedAt)}）：${
                      run()
                        .report?.split(/\n\s*\n/)[0]
                        ?.trim() ?? ""
                    }`,
                  )}
                />
              )}
            </If>
          </View>
          <If when={previous()}>
            {(run) => (
              <View style={{ gap: 6 }}>
                <Caption text={localizedText("Output", "输出")} />
                <View
                  role="button"
                  accessibilityLabel={run().title ?? uiText("report")}
                  onPress={() => props.onMove(previousIndex() - props.index)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  focusVisibleStyle={{
                    outlineWidth: 1,
                    outlineColor: c().blue,
                  }}
                  style={{
                    ...row,
                    minHeight: 56,
                    gap: 10,
                    paddingHorizontal: 12,
                    borderWidth: 1,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="panel" size={14} tone="muted" />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Label size={13} lines={1}>
                      {run().title ?? uiText("report")}
                    </Label>
                    <Label
                      size={11}
                      tone="muted"
                    >{`${uiText("report")} · ${routineTime(run().startedAt)}`}</Label>
                  </View>
                  <Icon name="right" size={10} tone="muted" />
                </View>
              </View>
            )}
          </If>
          <View style={{ gap: 6 }}>
            <Caption text={localizedText("Last 7 runs", "最近 7 次运行")} />
            <RoutineHistory runs={recent()} full />
            <View style={{ ...row, justifyContent: "space-between" }}>
              <Label size={10} tone="muted">
                {runDay(recent().at(-1)?.startedAt ?? props.run.startedAt)}
              </Label>
              <Label size={10} tone="muted">
                {runDay(recent()[0]?.startedAt ?? props.run.startedAt)}
              </Label>
            </View>
          </View>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          paddingHorizontal: 16,
          minHeight: 64,
          gap: 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={localizedText("Older reports", "较早的报告")}
          tone="ghost"
          disabled={props.index + 1 >= props.count}
          onPress={() => props.onMove(1)}
          style={{ paddingHorizontal: 0 }}
        />
        <Button
          label={uiText("runNow")}
          tone="primary"
          icon="right"
          size={36}
          disabled={!props.canRetry}
          onPress={props.onRetry}
        />
      </View>
    </Modal>
  );
}

export function RoutineReport(props: RoutineReportProps) {
  const c = colors();
  const failed = () =>
    props.run.status === "failed" || props.run.status === "skipped";
  const date = () =>
    new Date(props.run.startedAt).toLocaleString(
      formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
      {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      },
    );
  const content = () => (
    <View style={grow}>
      <View
        style={{
          ...row,
          paddingHorizontal: 16,
          gap: 8,
          height: 40,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={!props.phone}>
          <Button
            label={props.routine.name}
            icon="back"
            tone="ghost"
            onPress={props.onBack}
          />
        </If>
        <Label size={12} tone="muted" style={{ flex: 1 }}>
          {props.phone ? uiText("reports") : uiText("reports2")}
          {`${props.index + 1} ${uiText("of")} ${props.count}`}
        </Label>
        <Button
          label={uiText("newer")}
          disabled={props.index < 1}
          onPress={() => props.onMove(-1)}
        />
        <Button
          label={uiText("older")}
          disabled={props.index + 1 >= props.count}
          onPress={() => props.onMove(1)}
        />
      </View>
      <Scroll style={grow}>
        <View style={{ padding: 16, gap: 14 }}>
          <Label size={12} tone="muted">
            {date()}
          </Label>
          <If
            when={failed()}
            else={
              <>
                <Label size={18} weight={600}>
                  {props.run.title ?? uiText("report")}
                </Label>
                <Markdown
                  value={
                    props.run.report ??
                    (props.run.status === "running"
                      ? "Routine running…"
                      : "No report")
                  }
                  line={22}
                />
                <Each of={props.run.feedback} key={(entry) => entry.id}>
                  {(entry) => (
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderColor: c().border,
                        paddingTop: 10,
                        gap: 4,
                      }}
                    >
                      <Label size={12} weight={500}>
                        {uiText("me")}
                      </Label>
                      <Label>{entry().text}</Label>
                      <Label
                        size={12}
                        tone={entry().revisionFailed ? "red" : "muted"}
                      >
                        {entry().revisionFailed
                          ? uiText("theBriefCouldntBeUpdated")
                          : entry().briefVersion
                            ? uiText("briefUpdatedToV", {
                                briefVersion: entry().briefVersion,
                              })
                            : uiText("updatingTheBrief")}
                      </Label>
                    </View>
                  )}
                </Each>
              </>
            }
          >
            <Label size={18} weight={600}>
              {uiText("noReport")}
            </Label>
            <Label tone="muted">
              {props.run.error ?? uiText("theRoutineWasSkipped")}
            </Label>
            <Button
              label={uiText("retry")}
              disabled={!props.canRetry}
              onPress={props.onRetry}
              style={{ alignSelf: "flex-start" }}
            />
          </If>
        </View>
      </Scroll>
      <If when={!failed() && props.run.report}>
        <View
          style={{
            ...row,
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Field
            label={uiText("feedback")}
            placeholder={uiText("feedbackEGSkipFundingNews")}
            value={props.feedback}
            onChange={props.onFeedback}
            style={{ flex: 1 }}
          />
          <Button
            label={uiText("sendFeedback")}
            tone="primary"
            disabled={!props.feedback.trim() || props.routine.revising}
            onPress={props.onSend}
          />
        </View>
      </If>
    </View>
  );
  return (
    <If when={props.phone && props.index === 0 && failed()} else={content()}>
      <PhoneRoutineFailure {...props} />
    </If>
  );
}
