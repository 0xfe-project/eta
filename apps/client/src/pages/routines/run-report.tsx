import type { RoutineInfo, RunView } from "@eta/client-contracts";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Field,
  focusRing,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { UserFace } from "../../components/agent-face";
import { chatText, shownMentions } from "../../components/eta-editor";
import { StatusDot } from "../../components/status-dot";
import {
  avatar,
  border,
  control,
  icon,
  space,
  weight,
} from "../../components/tokens";
import { formatLocale, localizedText, uiText } from "../../i18n";
import { useAgentMentions } from "../../services/agent-mentions";
import { problemText } from "../../services/problem-text";
import { reportBody, RoutineHistory } from "./history";
import {
  clockTime,
  feedTime,
  routineTime,
  runAgo,
  scheduleLabel,
} from "./schedule";

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
  starting?: boolean;
  sendingFeedback?: boolean;
  onRetry: () => void;
  onToggle: () => void;
  onEdit: () => void;
  feedback: string;
  onFeedback: (value: string) => void;
  onSend: () => void;
}

/** The "Output" tag over a failed run's error. */
const badgeHeight = 20;
/** The report link row on a failed run's page. */
const reportRowHeight = 56;
/** A report's column on a wide screen. */
const columnWidth = 640;
/** The feedback box under a report, its border included. */
const feedbackHeight = 40;

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
  const agentMentions = useAgentMentions();
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
    (props.run.error && problemText(props.run.error)) ??
    (props.run.status === "skipped"
      ? uiText("theRoutineWasSkipped")
      : localizedText(
          "The routine failed without an error message.",
          "例行任务运行失败，未返回错误详情。",
        ));
  const schedule = () =>
    [
      scheduleLabel(props.routine.schedule),
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
      <SmoothScroll style={grow} scrollbar={false}>
        <View style={{ padding: space[16], gap: space[16] }}>
          <View style={{ gap: space[8] }}>
            <View style={{ ...row, gap: space[8] }}>
              <View
                style={{
                  height: badgeHeight,
                  paddingHorizontal: space[8],
                  justifyContent: "center",
                  backgroundColor: c().button,
                }}
              >
                <Label
                  tracking="caps"
                  variant="caption"
                  tone="buttonInk"
                  style={{ textTransform: "uppercase" }}
                >
                  {status()}
                </Label>
              </View>
              <Label variant="caption" tone="muted">
                {[`${runDay(props.run.startedAt)} ${time()}`, duration()]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            </View>
            <Label variant="caption" tone="muted">
              {schedule()}
            </Label>
          </View>
          <View style={{ gap: space[4] }}>
            <Caption text={uiText("report")} />
            <Label>{error()}</Label>
            <If when={previous()}>
              {(run) => (
                <chatText.View
                  plugins={[shownMentions()]}
                  label={uiText("report")}
                  text={{
                    mentions: agentMentions(),
                    text: localizedText(
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
                    ),
                  }}
                />
              )}
            </If>
          </View>
          <If when={previous()}>
            {(run) => (
              <View style={{ gap: space[4] }}>
                <Caption text={localizedText("Output", "输出")} />
                <View
                  role="button"
                  accessibilityLabel={run().title ?? uiText("report")}
                  onPress={() => props.onMove(previousIndex() - props.index)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  focusVisibleStyle={focusRing(c(), "inset")}
                  style={{
                    ...row,
                    minHeight: reportRowHeight,
                    gap: space[8],
                    paddingHorizontal: space[12],
                    borderWidth: 1,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="panel" size={icon.md} tone="muted" />
                  <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                    <Label variant="small" lines={1}>
                      {run().title ?? uiText("report")}
                    </Label>
                    <Label
                      variant="caption"
                      tone="muted"
                    >{`${uiText("report")} · ${routineTime(run().startedAt)}`}</Label>
                  </View>
                  <Icon name="right" size={icon.sm} tone="muted" />
                </View>
              </View>
            )}
          </If>
          <View style={{ gap: space[4] }}>
            <Caption text={localizedText("Last 7 runs", "最近 7 次运行")} />
            <RoutineHistory runs={recent()} full />
            <View style={{ ...row, justifyContent: "space-between" }}>
              <Label variant="caption" tone="muted">
                {runDay(recent().at(-1)?.startedAt ?? props.run.startedAt)}
              </Label>
              <Label variant="caption" tone="muted">
                {runDay(recent()[0]?.startedAt ?? props.run.startedAt)}
              </Label>
            </View>
          </View>
        </View>
      </SmoothScroll>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          paddingHorizontal: space[16],
          minHeight: space[64],
          gap: space[8],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={uiText("olderReports")}
          tone="ghost"
          disabled={props.index + 1 >= props.count}
          onPress={() => props.onMove(1)}
          style={{ paddingHorizontal: 0 }}
        />
        <Button
          label={uiText("runNow")}
          tone="primary"
          icon="play"
          size={control.touch}
          labelWeight={weight.strong}
          style={{ paddingHorizontal: space[16], gap: space[4] }}
          disabled={!props.canRetry}
          busy={props.starting}
          onPress={props.onRetry}
        />
      </View>
    </Modal>
  );
}

export function RoutineReport(props: RoutineReportProps) {
  const agentMentions = useAgentMentions();
  const c = colors();
  const type = textFaces();
  const failed = () =>
    props.run.status === "failed" || props.run.status === "skipped";
  const sendable = () => !!props.feedback.trim() && !props.routine.revising;
  // A finished run also says how long it took.
  const date = () =>
    [feedTime(props.run.startedAt), recordedDuration(props.run)]
      .filter(Boolean)
      .join(" · ");
  const inset = () => (props.phone ? space[16] : space[32]);
  const column = { width: "100%", maxWidth: columnWidth } as const;
  const move = (label: string, enabled: boolean, by: number) => (
    <View
      role="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      onPress={() => {
        if (enabled) props.onMove(by);
      }}
      focusVisibleStyle={focusRing(c(), "inset")}
      style={{ cursor: enabled ? "pointer" : "default" }}
    >
      <Label
        variant="small"
        tone={enabled ? "ink" : props.phone ? "muted" : "faint"}
      >
        {label}
      </Label>
    </View>
  );
  const content = () => (
    <View style={grow}>
      <View
        style={{
          ...row,
          paddingHorizontal: inset(),
          gap: props.phone ? space[12] : space[16],
          height: props.phone ? space[40] : space[48],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <View style={{ ...row, gap: space[8], flex: 1, minWidth: 0 }}>
          <If
            when={!props.phone}
            else={
              <Label variant="small" tone="muted">
                {`${uiText("reports")}${uiText("reportPosition", {
                  index: props.index + 1,
                  count: props.count,
                })}`}
              </Label>
            }
          >
            <View
              role="button"
              accessibilityLabel={props.routine.name}
              onPress={props.onBack}
              focusVisibleStyle={focusRing(c(), "inset")}
              style={{ ...row, gap: space[8], minWidth: 0, cursor: "pointer" }}
            >
              <Icon name="arrowLeft" size={icon.sm} />
              <Label variant="small" lines={1}>
                {props.routine.name}
              </Label>
            </View>
            <Label variant="small" tone="muted">
              {uiText("reportsTrail")}
            </Label>
          </If>
        </View>
        <If when={!props.phone}>
          <Label variant="small" tone="muted">
            {uiText("reportPosition", {
              index: props.index + 1,
              count: props.count,
            })}
          </Label>
        </If>
        {move(uiText("newer"), props.index > 0, -1)}
        {move(uiText("older"), props.index + 1 < props.count, 1)}
      </View>
      <SmoothScroll style={grow}>
        <View
          style={{
            alignItems: "center",
            paddingTop: props.phone ? space[16] : space[20],
            paddingBottom: space[16],
            paddingHorizontal: inset(),
          }}
        >
          <View
            style={{
              ...column,
              gap: props.phone ? space[8] : space[4],
              // On the phone a missed run sits in a card.
              ...(props.phone && failed()
                ? {
                    gap: space[4],
                    padding: space[12],
                    borderWidth: 1,
                    borderColor: c().border,
                  }
                : undefined),
            }}
          >
            <Label variant="small" tone="muted">
              {date()}
            </Label>
            <View
              style={{ gap: props.phone && failed() ? space[4] : space[8] }}
            >
              <If
                when={failed()}
                else={
                  <>
                    <Label variant="subtitle" weight={weight.strong}>
                      {props.run.title ?? uiText("report")}
                    </Label>
                    <chatText.View
                      plugins={[shownMentions()]}
                      text={{
                        text: props.run.report
                          ? reportBody(props.run)
                          : props.run.status === "running"
                            ? "Routine running…"
                            : "No report",
                        mentions: agentMentions(),
                      }}
                      streaming={props.run.status === "running"}
                      label={props.run.title ?? uiText("report")}
                    />
                  </>
                }
              >
                <View style={{ ...row, gap: space[8] }}>
                  <StatusDot color={c().red} />
                  <Label
                    variant="subtitle"
                    weight={weight.strong}
                    tone={props.phone ? "muted" : "mutedInk"}
                  >
                    {uiText("noReport")}
                  </Label>
                </View>
                <Label tone={props.phone ? "muted" : "mutedInk"}>
                  {props.run.error
                    ? problemText(props.run.error)
                    : uiText("theRoutineWasSkipped")}
                </Label>
                <View
                  style={{ ...row, paddingTop: props.phone ? space[4] : 0 }}
                >
                  <Button
                    label={uiText("retry")}
                    disabled={!props.canRetry}
                    busy={props.starting}
                    onPress={props.onRetry}
                    size={props.phone ? control.touch : undefined}
                    style={
                      props.phone ? { paddingHorizontal: space[12] } : undefined
                    }
                  />
                </View>
              </If>
            </View>
          </View>
        </View>
        <If
          when={
            props.run.status !== "running" && (failed() || props.run.report)
          }
        >
          <View
            style={{
              alignItems: "center",
              paddingVertical: space[16],
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <View style={{ ...column, gap: space[12] }}>
              <Each of={props.run.feedback} key={(entry) => entry.id}>
                {(entry) => (
                  <View
                    style={{ ...row, alignItems: "flex-start", gap: space[8] }}
                  >
                    <UserFace size={avatar.md} />
                    <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
                      <View
                        style={{
                          ...row,
                          alignItems: "baseline",
                          gap: space[8],
                        }}
                      >
                        <Label variant="small" weight={weight.strong}>
                          {uiText("me")}
                        </Label>
                        <Label variant="small" tone="muted">
                          {`${runDay(entry().createdAt)} ${clockTime(entry().createdAt)}`}
                        </Label>
                      </View>
                      <Label>{entry().text}</Label>
                      <Label
                        variant="small"
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
                  </View>
                )}
              </Each>
              <View
                style={{
                  ...row,
                  height: feedbackHeight,
                  gap: space[8],
                  paddingHorizontal: space[12],
                  borderWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Field
                  label={uiText("feedback")}
                  placeholder={uiText("feedbackEGSkipFundingNews")}
                  value={props.feedback}
                  onChange={props.onFeedback}
                  onSubmit={() => {
                    if (sendable()) props.onSend();
                  }}
                  style={{
                    flex: 1,
                    height: feedbackHeight - 2 * border.hair,
                    ...textStyle(type("small")),
                    paddingHorizontal: 0,
                    borderWidth: 0,
                  }}
                />
                <Button
                  label={uiText("sendFeedback")}
                  icon="send"
                  iconSize={icon.md}
                  labelTone="muted"
                  iconOnly
                  tone="ghost"
                  // The glyph sits on the box's 10px inset.
                  style={{ marginRight: -space[4] }}
                  disabled={!sendable()}
                  busy={props.sendingFeedback}
                  onPress={props.onSend}
                />
              </View>
            </View>
          </View>
        </If>
      </SmoothScroll>
    </View>
  );
  return (
    <If when={props.phone && props.index === 0 && failed()} else={content()}>
      <PhoneRoutineFailure {...props} />
    </If>
  );
}
