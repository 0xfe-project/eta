import type { UpgradePhase } from "@eta/client-contracts";
import type { HostUpdate } from "./host-update";
import { openUrl, View } from "nsh";
import {
  Button,
  colors,
  Icon,
  Label,
  Markdown,
  row,
} from "../../../components";
import { DownloadProgressBar } from "../../../components/download-progress";
import { StatusDot } from "../../../components/status-dot";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { canStartHost } from "../../connection/local-host";
import { BusyList } from "./busy-list";

const phaseName = {
  starting: "updatePreparing",
  downloading: "updateDownloading",
  waiting: "updateWaiting",
  stopping: "updateStopping",
  "backing-up": "updateBackingUp",
  restarting: "updateRestarting",
  verifying: "updateVerifying",
  "rolling-back": "restoringThePreviousVersion",
} as const satisfies Record<UpgradePhase, Parameters<typeof uiText>[0]>;

const blockedExplanation = {
  source: "updateCheckout",
  "no-service": "updateNeedsService",
  "no-windows-service": "updateNeedsWindowsService",
  "other-file": "updateDifferentBinary",
} as const;

function percent(received: number, total?: number) {
  return total && total > 0
    ? Math.max(0, Math.min(100, Math.round((100 * received) / total)))
    : undefined;
}

export function HostRelease(props: { update: HostUpdate; phone: boolean }) {
  const host = useHost();
  const c = colors();
  const {
    version,
    offer,
    canUpdate,
    failed,
    check,
    active,
    status,
    pending,
    connected,
    error,
    confirm,
    editor,
    notes,
    request,
  } = props.update;
  const desktopTitle = () => {
    const address = host.address();
    if (address?.local) return uiText("updateLocalHost");
    return canStartHost && address
      ? `eta host · ${address.origin}`
      : uiText("updateServerHost");
  };
  const statusTone = () => {
    if (active()) return "blue";
    if (failed() || check()?.error) return "red";
    if (offer()) return "blue";
    if (check()?.blocked || check()?.heldOnPrerelease) return "amber";
    return "green";
  };
  const statusLabel = () => {
    if (active()) return uiText(phaseName[status()!.phase]);
    if (failed()) return uiText("updateLastFailed");
    if (check()?.error) return uiText("updateCheckFailed");
    if (offer()) return uiText("updateAvailable");
    if (check()?.heldOnPrerelease) return uiText("updatePreRelease");
    if (check()?.blocked) return uiText("updateManual");
    return uiText("updateUpToDate");
  };
  const phase = () => status()?.phase;
  const canCancel = () =>
    host.can("upgrade.cancel") &&
    ["starting", "downloading", "waiting"].includes(phase() ?? "");
  const offerLabel = () =>
    uiText("updateToVersion", { version: check()?.latest ?? "" });
  const note = () => check()?.notes;
  const progress = () => status()?.download;
  const updateAction = () => (
    <If
      when={active()}
      else={
        <If when={offer()}>
          <Button
            label={offerLabel()}
            disabled={!canUpdate()}
            onPress={() => {
              error.set("");
              confirm.set(true);
            }}
          />
        </If>
      }
    >
      <If when={canCancel()}>
        <Button
          label={uiText("cancelUpdate")}
          disabled={!connected() || !!pending()}
          onPress={() => void request("cancel", {})}
        />
      </If>
    </If>
  );

  return (
    <>
      <View
        style={{
          ...(props.phone ? {} : row),
          alignItems: props.phone ? "stretch" : "flex-start",
          gap: props.phone ? 4 : 10,
          minHeight: 73,
          paddingVertical: 8,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={!props.phone}>
          <View
            style={{
              width: 24,
              height: 24,
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrowCircleUp" tone="muted" size={16} />
          </View>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View testID="host-version">
            <Label size={14} line={20} weight={500}>
              {version()}
            </Label>
          </View>
          <If when={props.phone}>
            <View style={{ ...row, gap: 5 }}>
              <StatusDot color={c()[statusTone()]} />
              <Label size={12} line={16} tone="mutedInk">
                {statusLabel()}
              </Label>
            </View>
          </If>
          <Label size={12} line={17} tone="muted">
            {desktopTitle()}
          </Label>
          <If when={offer() && note() && !active()}>
            <View
              role="button"
              accessibilityState={{ expanded: notes() }}
              onPress={() => notes.set(!notes())}
              style={{
                ...row,
                gap: 5,
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
            >
              <Label size={12} line={17} tone="mutedInk">
                {uiText("whatsNew")}
              </Label>
              <Icon name={notes() ? "down" : "right"} size={12} tone="muted" />
            </View>
          </If>
        </View>
        <If
          when={props.phone}
          else={
            <View style={{ width: 146, alignItems: "flex-start", gap: 7 }}>
              <View style={{ ...row, gap: 6 }}>
                <StatusDot color={c()[statusTone()]} />
                <Label size={12} line={18} tone="mutedInk">
                  {statusLabel()}
                </Label>
              </View>
              {updateAction()}
            </View>
          }
        >
          <If when={active() || offer()}>
            <View style={{ alignItems: "flex-start" }}>{updateAction()}</View>
          </If>
        </If>
      </View>
      <If when={notes() && offer() && !active() ? note() : undefined}>
        {(release) => (
          <View
            style={{
              padding: 16,
              gap: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Markdown value={release().text} compactHeadings />
            <If when={release().url}>
              {(url) => (
                <Button
                  label={uiText("readFullReleaseNotes")}
                  onPress={() => void host.action(() => openUrl(url()))}
                />
              )}
            </If>
          </View>
        )}
      </If>
      <If when={active() && (progress() || status()?.busy?.length)}>
        <View
          style={{
            padding: 16,
            gap: 8,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={progress()}>
            {(download) => (
              <DownloadProgressBar
                value={percent(download().received, download().total)}
              />
            )}
          </If>
          <BusyList work={status()?.busy ?? []} label={uiText("waitingFor")} />
        </View>
      </If>
      <If
        when={
          (error() && !editor() && !confirm()) ||
          (failed() && status()?.error) ||
          check()?.error ||
          check()?.blocked
        }
      >
        <View
          style={{
            paddingHorizontal: 16,
            paddingVertical: 8,
            gap: 3,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <If
            when={
              (error() && !editor() && !confirm()) ||
              (failed() && status()?.error) ||
              check()?.error
            }
          >
            <Label size={12} tone="red">
              {(error() && !editor() && !confirm() ? error() : "") ||
                (failed() ? status()?.error : "") ||
                check()?.error}
            </Label>
          </If>
          <If when={check()?.blocked}>
            {(blocked) => (
              <Label size={12} tone="muted">
                {uiText(blockedExplanation[blocked()])}
              </Label>
            )}
          </If>
        </View>
      </If>
    </>
  );
}
