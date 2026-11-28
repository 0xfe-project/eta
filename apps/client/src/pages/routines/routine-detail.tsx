import type {
  BriefView,
  RoutineInfo,
  RoutineResults,
  RoutineTriggerView,
  RunView,
  WebhookTriggerInfo,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import { effect, signal, untracked, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  focusRing,
  grow,
  Label,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { EmptyState } from "../../components/empty-state";
import { showToast } from "../../components/toast";
import { ToggleSwitch } from "../../components/toggle-switch";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import {
  Badge,
  Callout,
  ConfirmDialog,
  CopyButton,
  Field,
  WarningLine,
} from "../../ui";
import { EarlierReportCard, LatestReportCard } from "./history";
import {
  clockDistance,
  clockTime,
  dayWord,
  feedTime,
  formatTriggerConfigSummary,
  isLoopbackWebhookUrl,
  scheduleFor,
  shortDate,
  triggerModeLabel,
  triggerStatusMeta,
  triggerTargetLabel,
  webhookCurlCommand,
  webhookFullUrl,
} from "./schedule";

/** The schedule and brief labels, and the time column of the timeline under them. */
const labelWidth = 72;
const secretMask = "••••••••••••••••••••••••••••••••";

function webhookAuthLabel(info: WebhookTriggerInfo) {
  if (info.authMode === "header") {
    return uiText("webhookAuthHeader", {
      header: info.headerName || "Authorization",
    });
  }
  if (info.authMode === "hmac-sha256") {
    return uiText("webhookAuthHmac", {
      header: info.headerName || "X-Hub-Signature-256",
    });
  }
  return uiText("webhookAuthNone");
}

function InboundWebhookPanel(props: {
  routine: RoutineInfo;
  phone: boolean;
  inset: number;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();

  const info = signal<WebhookTriggerInfo | null>(null);
  const loading = signal(false);
  const loadError = signal("");
  const secretVisible = signal(false);
  const customSecret = signal("");
  const savingSecret = signal(false);
  const rotating = signal(false);
  const confirmRotate = signal(false);
  let requestSeq = 0;

  async function fetchInfo(routineId: string) {
    const seq = ++requestSeq;
    loading.set(true);
    loadError.set("");
    try {
      const result = await host.call<RoutineResults["webhookInfo"]>(
        "routines",
        "webhookInfo",
        { routineId },
      );
      if (seq !== requestSeq) return;
      if (result && typeof result.path === "string" && result.path !== "") {
        info.set(result);
      } else {
        info.set(null);
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      loadError.set(problemText(error));
    } finally {
      if (seq === requestSeq) loading.set(false);
    }
  }

  effect(() => {
    const routineId = props.routine.id;
    const provider = props.routine.trigger?.provider;
    const configKey = JSON.stringify(props.routine.trigger?.config ?? {});
    const updatedAt = props.routine.updatedAt;
    void configKey;
    void updatedAt;
    untracked(() => {
      secretVisible.set(false);
      customSecret.set("");
      confirmRotate.set(false);
      savingSecret.set(false);
      rotating.set(false);
      if (provider !== "webhook") {
        requestSeq++;
        info.set(null);
        loading.set(false);
        loadError.set("");
        return;
      }
      if (!host.can("routines.webhookInfo") && host.state().ops.length > 0) {
        return;
      }
      void fetchInfo(routineId);
    });
  });

  const fullUrl = () => {
    const current = info();
    if (!current) return "";
    return webhookFullUrl(current, host.address()?.origin);
  };

  const canRotate = () =>
    host.can("routines.webhookRotate") || host.state().ops.length === 0;
  const canSetSecret = () =>
    host.can("routines.webhookSetSecret") || host.state().ops.length === 0;

  async function saveSecret() {
    const trimmed = customSecret().trim();
    if (!trimmed || savingSecret()) return;
    const targetId = props.routine.id;
    const seq = ++requestSeq;
    savingSecret.set(true);
    const updated = await host.action(() =>
      host.call<RoutineResults["webhookSetSecret"]>(
        "routines",
        "webhookSetSecret",
        { routineId: targetId, secret: trimmed },
      ),
    );
    savingSecret.set(false);
    if (seq !== requestSeq || props.routine.id !== targetId) return;
    if (updated && typeof updated.path === "string") {
      info.set(updated);
      customSecret.set("");
      showToast({ title: uiText("webhookSecretSaved"), tone: "green" });
    }
  }

  async function rotateCredentials() {
    if (rotating()) return;
    const targetId = props.routine.id;
    const seq = ++requestSeq;
    rotating.set(true);
    const updated = await host.action(() =>
      host.call<RoutineResults["webhookRotate"]>("routines", "webhookRotate", {
        routineId: targetId,
      }),
    );
    rotating.set(false);
    if (seq !== requestSeq || props.routine.id !== targetId) return;
    if (updated && typeof updated.path === "string") {
      info.set(updated);
      confirmRotate.set(false);
      secretVisible.set(false);
      showToast({ title: uiText("webhookRotated"), tone: "green" });
    }
  }

  return (
    <If when={info() || loading() || loadError()}>
      <View
        style={{
          paddingVertical: space[12],
          paddingHorizontal: props.inset,
          gap: space[8],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <View
          style={{
            ...row,
            gap: space[8],
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <Label variant="small" weight={weight.strong}>
            {uiText("webhookPanelTitle")}
          </Label>
          <If when={info()}>
            {(current) => (
              <Badge
                label={webhookAuthLabel(current())}
                tone="neutral"
                size="caption"
              />
            )}
          </If>
          <View style={{ flex: 1 }} />
          <If when={info() && canRotate()}>
            <Button
              label={uiText("webhookRotate")}
              icon="refresh"
              size={props.phone ? control.md : control.sm}
              onPress={() => confirmRotate.set(true)}
            />
          </If>
        </View>

        <If when={loading() && !info()}>
          <Label variant="small" tone="muted">
            {uiText("webhookLoading")}
          </Label>
        </If>

        <If when={loadError()}>
          <Callout
            tone="danger"
            icon="warning"
            title={uiText("webhookLoadError")}
            description={loadError()}
            actions={
              <Button
                label={uiText("retry")}
                size={control.sm}
                onPress={() => void fetchInfo(props.routine.id)}
              />
            }
          />
        </If>

        <If when={info()}>
          {(current) => (
            <>
              <View
                style={{
                  gap: space[8],
                  padding: space[8],
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().surface,
                }}
              >
                <Label variant="small" mono>
                  {fullUrl()}
                </Label>
                <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
                  <CopyButton
                    label={uiText("webhookCopyUrl")}
                    value={fullUrl}
                    size={props.phone ? control.md : control.sm}
                  />
                  <CopyButton
                    label={uiText("webhookCopyCurl")}
                    value={() => webhookCurlCommand(fullUrl(), current())}
                    size={props.phone ? control.md : control.sm}
                  />
                </View>
              </View>

              <If when={isLoopbackWebhookUrl(fullUrl())}>
                <WarningLine
                  text={uiText("webhookLoopbackHint")}
                  outline={!props.phone}
                />
              </If>

              <If when={current().authMode !== "none"}>
                <View style={{ gap: space[8], paddingTop: space[4] }}>
                  <View
                    style={{
                      ...row,
                      gap: space[8],
                      flexWrap: "wrap",
                      alignItems: "center",
                    }}
                  >
                    <Label variant="small" tone="muted">
                      {uiText("webhookSecretLabel")}
                    </Label>
                    <Label
                      variant="small"
                      mono
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      {secretVisible() ? (current().secret ?? "") : secretMask}
                    </Label>
                    <Button
                      label={
                        secretVisible()
                          ? uiText("webhookHideSecret")
                          : uiText("webhookShowSecret")
                      }
                      size={props.phone ? control.md : control.sm}
                      disabled={!current().secret}
                      onPress={() => secretVisible.set(!secretVisible())}
                    />
                    <CopyButton
                      label={uiText("webhookCopySecret")}
                      value={() => current().secret ?? ""}
                      disabled={!current().secret}
                      size={props.phone ? control.md : control.sm}
                    />
                  </View>
                  <If when={canSetSecret()}>
                    <View
                      style={{ ...row, gap: space[8], alignItems: "center" }}
                    >
                      <Field
                        label={uiText("webhookCustomSecretLabel")}
                        placeholder={uiText("webhookCustomSecretPlaceholder")}
                        masked
                        value={customSecret()}
                        onChange={customSecret.set}
                        onSubmit={() => void saveSecret()}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          height: props.phone ? control.lg : control.md,
                          paddingHorizontal: space[8],
                          ...textStyle(type("small")),
                        }}
                      />
                      <Button
                        label={uiText("save")}
                        size={props.phone ? control.lg : control.md}
                        disabled={!customSecret().trim() || savingSecret()}
                        busy={savingSecret()}
                        onPress={() => void saveSecret()}
                      />
                    </View>
                  </If>
                </View>
              </If>
            </>
          )}
        </If>

        <If when={confirmRotate()}>
          <ConfirmDialog
            title={uiText("webhookRotateTitle")}
            description={uiText("webhookRotateBody")}
            confirmLabel={uiText("webhookRotateConfirm")}
            tone="danger"
            phone={props.phone}
            busy={rotating()}
            onConfirm={() => void rotateCredentials()}
            onClose={() => confirmRotate.set(false)}
          />
        </If>
      </View>
    </If>
  );
}

function TriggerSummaryDetail(props: {
  trigger: RoutineTriggerView;
  compact?: boolean;
}) {
  const modeText = () =>
    triggerModeLabel(props.trigger.mode, props.trigger.pollingIntervalMinutes);
  const statusMeta = () => triggerStatusMeta(props.trigger.status);
  const configSummary = () => formatTriggerConfigSummary(props.trigger.config);
  return (
    <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
      <View
        style={{
          ...row,
          gap: space[8],
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <Label
          variant="small"
          tone="mutedInk"
          style={{ flexShrink: 1, minWidth: 0 }}
        >
          {triggerTargetLabel(props.trigger)}
        </Label>
        <Badge
          label={statusMeta().label}
          tone={statusMeta().tone}
          size="caption"
        />
        <If when={modeText()}>
          {(mode) => <Badge label={mode()} tone="neutral" size="caption" />}
        </If>
        <If when={props.trigger.provider === "web-monitor"}>
          <Label variant="caption" tone="muted">
            {props.trigger.lastCheckedAt != null
              ? uiText("triggerLastCheckedAt", {
                  time: feedTime(props.trigger.lastCheckedAt),
                })
              : uiText("triggerNotCheckedYet")}
          </Label>
          <Label variant="caption" tone="muted">
            {props.trigger.lastEventAt
              ? uiText("triggerLastChangeAt", {
                  time: feedTime(props.trigger.lastEventAt),
                })
              : uiText("triggerNoChangesYet")}
          </Label>
        </If>
        <If when={props.trigger.provider === "file-watch"}>
          <Label variant="caption" tone="muted">
            {props.trigger.watchedCount != null
              ? props.trigger.watchedCount === 1
                ? uiText("triggerWatchedPathsCount", { count: 1 })
                : uiText("triggerWatchedPathsCountPlural", {
                    count: props.trigger.watchedCount,
                  })
              : uiText("triggerNotWatching")}
          </Label>
          <Label variant="caption" tone="muted">
            {props.trigger.lastEventAt
              ? uiText("triggerLastEventAt", {
                  time: feedTime(props.trigger.lastEventAt),
                })
              : uiText("triggerNoEventsYet")}
          </Label>
        </If>
        <If
          when={
            props.trigger.provider !== "web-monitor" &&
            props.trigger.provider !== "file-watch"
          }
        >
          <If when={props.trigger.lastCheckedAt != null}>
            <Label variant="caption" tone="muted">
              {uiText("triggerLastCheckedAt", {
                time: feedTime(props.trigger.lastCheckedAt!),
              })}
            </Label>
          </If>
          <Label variant="caption" tone="muted">
            {props.trigger.lastEventAt
              ? uiText("triggerLastEventAt", {
                  time: feedTime(props.trigger.lastEventAt),
                })
              : uiText("triggerNoEventsYet")}
          </Label>
        </If>
      </View>
      <If when={configSummary()}>
        {(summary) => (
          <Label variant="caption" tone="muted">
            {summary()}
          </Label>
        )}
      </If>
      <If when={props.trigger.fallbackReason}>
        {(reason) => (
          <WarningLine
            text={uiText("triggerFallbackNotice", { reason: reason() })}
            outline={!props.compact}
          />
        )}
      </If>
      <If when={props.trigger.lastError}>
        {(err) => (
          <Callout
            tone="danger"
            icon="warning"
            title={uiText("triggerErrorSummary")}
            description={err()}
          />
        )}
      </If>
    </View>
  );
}

export function RoutineDetail(props: {
  routine: RoutineInfo;
  brief?: BriefView;
  firstBrief?: BriefView;
  layout: Layout;
  runs: RunView[];
  canRun: boolean;
  starting?: boolean;
  onRun: () => void;
  onReport: (id: string) => void;
  onReadBrief: () => void;
  onEdit: () => void;
  /** Dimmed when the connection cannot delete routines. */
  canDelete: boolean;
  onDelete: () => void;
  onToggle: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  const inset = () => (phone() ? space[16] : space[24]);
  const trigger = () => props.routine.trigger ?? null;
  const latest = () => props.runs.find((run) => run.status === "sent");
  const earlier = () => props.runs.filter((run) => run.id !== latest()?.id);
  // Two cards a row on the desktop, one on the narrower layouts.
  const earlierRows = () => {
    const perRow = props.layout === "desktop" ? 2 : 1;
    const rows: RunView[][] = [];
    for (let index = 0; index < earlier().length; index += perRow)
      rows.push(earlier().slice(index, index + perRow));
    return rows;
  };
  const nextStatusText = () => {
    if (props.routine.nextRunAt) {
      return uiText("nextReportOn", {
        // The phone has no time column, so the time joins the day.
        day: phone()
          ? `${dayWord(props.routine.nextRunAt)} ${clockTime(props.routine.nextRunAt)}`
          : dayWord(props.routine.nextRunAt),
        clockDistance: clockDistance(props.routine.nextRunAt),
      });
    }
    if (!props.routine.enabled) return uiText("paused");
    const activeTrigger = trigger();
    if (props.routine.schedule === null && activeTrigger) {
      if (activeTrigger.status === "error")
        return uiText("triggerErrorDetailHint");
      if (activeTrigger.status === "disabled")
        return uiText("triggerStatusDisabled");
      return uiText("triggerWaitingForEvents");
    }
    return uiText("noUpcomingRun");
  };
  const nextStatusTone = () =>
    props.routine.enabled &&
    props.routine.schedule === null &&
    trigger()?.status === "error"
      ? ("red" as const)
      : ("mutedInk" as const);
  return (
    <View style={grow}>
      <If when={props.layout !== "phone"}>
        <View
          style={{
            paddingVertical: space[12],
            paddingHorizontal:
              props.layout === "desktop" ? space[32] : space[24],
            gap: space[4],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <View style={{ ...row, height: space[24], gap: space[16] }}>
            <Label
              variant="subtitle"
              weight={weight.strong}
              style={{ flex: 1 }}
            >
              {props.routine.name}
            </Label>
            <View style={{ ...row, gap: space[8] }}>
              <ToggleSwitch
                label={
                  props.routine.enabled ? uiText("pause") : uiText("resume")
                }
                checked={props.routine.enabled}
                compact
                onChange={props.onToggle}
              />
              <Button
                label={uiText("runNow")}
                icon="play"
                iconSize={icon.md}
                iconOnly
                tone="ghost"
                disabled={!props.canRun}
                busy={props.starting}
                onPress={props.onRun}
              />
              <ActionMenu
                label={uiText("routineActions")}
                iconSize={icon.md}
                triggerStyle={{
                  minWidth: space[24],
                  width: space[24],
                  height: space[24],
                  paddingHorizontal: 0,
                }}
              >
                <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
                <ActionItem
                  label={uiText("deleteRoutineMenu")}
                  tone="red"
                  disabled={!props.canDelete}
                  onSelect={props.onDelete}
                />
              </ActionMenu>
            </View>
          </View>
          <If when={props.routine.schedule !== null}>
            <View style={{ ...row, gap: space[12] }}>
              <Label variant="small" tone="muted" style={{ width: labelWidth }}>
                {uiText("schedule")}
              </Label>
              <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
                {scheduleFor(props.routine.schedule, props.routine.timezone)}
              </Label>
            </View>
          </If>
          <If when={trigger()}>
            {(entry) => (
              <View
                style={{ ...row, alignItems: "flex-start", gap: space[12] }}
              >
                <Label
                  variant="small"
                  tone="muted"
                  style={{ width: labelWidth, flexShrink: 0 }}
                >
                  {uiText("triggerLabel")}
                </Label>
                <TriggerSummaryDetail trigger={entry()} />
              </View>
            )}
          </If>
          <View style={{ ...row, gap: space[12] }}>
            <Label variant="small" tone="muted" style={{ width: labelWidth }}>
              {uiText("briefV", {
                value1: props.brief?.version ?? 1,
              })}
            </Label>
            <Label
              variant="small"
              tone="mutedInk"
              lines={1}
              style={{ flex: 1 }}
            >
              {props.brief?.text ?? ""}
            </Label>
            <View
              role="button"
              accessibilityLabel={uiText("readBrief")}
              onPress={props.onReadBrief}
              focusVisibleStyle={focusRing(c(), "inset")}
              style={{ flexShrink: 0, cursor: "pointer" }}
            >
              <Label
                variant="small"
                style={{
                  textDecorationLine: "underline",
                  textDecorationThickness: 1,
                }}
              >
                {uiText("readBrief")}
              </Label>
            </View>
          </View>
        </View>
      </If>
      <SmoothScroll style={grow} scrollbar={false}>
        <If when={phone()}>
          <View
            style={{
              paddingVertical: space[12],
              paddingHorizontal: space[16],
              gap: space[4],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <If when={props.routine.schedule !== null}>
              <View style={{ ...row, alignItems: "baseline", gap: space[12] }}>
                <Label
                  variant="small"
                  tone="muted"
                  style={{ width: space[64] }}
                >
                  {uiText("schedule")}
                </Label>
                <Label variant="small" tone="mutedInk" style={{ flex: 1 }}>
                  {scheduleFor(props.routine.schedule, props.routine.timezone)}
                </Label>
              </View>
            </If>
            <If when={trigger()}>
              {(entry) => (
                <View
                  style={{ ...row, alignItems: "flex-start", gap: space[12] }}
                >
                  <Label
                    variant="small"
                    tone="muted"
                    style={{ width: space[64], flexShrink: 0 }}
                  >
                    {uiText("triggerLabel")}
                  </Label>
                  <TriggerSummaryDetail trigger={entry()} compact />
                </View>
              )}
            </If>
            <View style={{ ...row, alignItems: "baseline", gap: space[12] }}>
              <Label variant="small" tone="muted" style={{ width: space[64] }}>
                {uiText("briefV", { value1: props.brief?.version ?? 1 })}
              </Label>
              <Label lines={3} style={{ flex: 1 }}>
                {props.brief?.text ?? ""}
              </Label>
            </View>
          </View>
        </If>
        <View
          style={{
            ...row,
            ...(phone() ? { height: control.touch } : { minHeight: space[32] }),
            paddingHorizontal: inset(),
            gap: space[12],
          }}
        >
          <If when={phone() ? null : props.routine.nextRunAt}>
            {(at) => (
              <Label
                variant="small"
                tone="mutedInk"
                style={{ width: labelWidth, flexShrink: 0 }}
              >
                {clockTime(at())}
              </Label>
            )}
          </If>
          <Label variant="small" tone={nextStatusTone()} style={{ flex: 1 }}>
            {nextStatusText()}
          </Label>
          <Button
            label={uiText("runNow")}
            icon="play"
            tone="ghost"
            disabled={!props.canRun}
            busy={props.starting}
            style={{ gap: space[4], paddingHorizontal: 0 }}
            onPress={props.onRun}
          />
        </View>
        <If when={trigger()?.provider === "webhook"}>
          <InboundWebhookPanel
            routine={props.routine}
            phone={phone()}
            inset={inset()}
          />
        </If>
        <If when={!props.runs.length}>
          <EmptyState
            size="row"
            status="empty"
            loading={null}
            error={null}
            empty={{
              title: props.routine.nextRunAt
                ? uiText("routineNoRunsYetNext", {
                    time: `${dayWord(props.routine.nextRunAt)} ${clockTime(props.routine.nextRunAt)}`,
                  })
                : props.routine.schedule === null && trigger()
                  ? uiText("routineNoRunsYetTrigger")
                  : uiText("routineNoRunsYet"),
            }}
            style={{
              paddingVertical: space[16],
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          />
        </If>
        <If when={latest()}>
          {(run) => (
            <View
              style={{
                paddingVertical: space[16],
                paddingHorizontal: inset(),
                borderTopWidth: 1,
                borderColor: c().border,
              }}
            >
              <LatestReportCard
                run={run()}
                phone={phone()}
                onOpen={() => props.onReport(run().id)}
              />
            </View>
          )}
        </If>
        <If when={earlier().length}>
          <View
            style={{
              ...(phone()
                ? { padding: space[16], gap: space[12] }
                : {
                    paddingTop: space[8],
                    paddingBottom: space[16],
                    gap: space[8],
                  }),
              paddingHorizontal: inset(),
              borderTopWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label variant="small" tone="muted">
              {uiText("earlierReports")}
            </Label>
            <View
              style={{ gap: props.layout === "desktop" ? space[12] : space[8] }}
            >
              <Each of={earlierRows()} key={(cards) => cards[0]!.id}>
                {(cards) => (
                  <View
                    style={{ ...row, alignItems: "stretch", gap: space[12] }}
                  >
                    <Each of={cards()} key={(run) => run.id}>
                      {(run) => (
                        <EarlierReportCard
                          run={run()}
                          onOpen={() => props.onReport(run().id)}
                          onRetry={props.onRun}
                          canRetry={props.canRun}
                          compact={props.layout === "tablet"}
                        />
                      )}
                    </Each>
                    <If
                      when={cards().length === 1 && props.layout === "desktop"}
                    >
                      <View style={grow} />
                    </If>
                  </View>
                )}
              </Each>
            </View>
          </View>
        </If>
        <View
          style={{
            ...row,
            ...(phone()
              ? { height: control.touch, borderBottomWidth: 1 }
              : { minHeight: space[32] }),
            paddingHorizontal: inset(),
            gap: space[12],
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={!phone()}>
            <Label
              variant="small"
              tone="muted"
              style={{ width: labelWidth, flexShrink: 0 }}
            >
              {shortDate(props.routine.createdAt)}
            </Label>
          </If>
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {uiText("routineCreatedMarker", {
              version: props.firstBrief?.version ?? 1,
              date: shortDate(props.routine.createdAt),
            })}
          </Label>
        </View>
      </SmoothScroll>
    </View>
  );
}
