import type { UpgradePhase } from "@eta/client-contracts";
import type { HostUpdate } from "./host-update";
import { openUrl, View } from "nsh";
import { Button, colors, Icon, Label, row } from "../../../components";
import { chatText } from "../../../components/eta-editor";
import { StatusDot } from "../../../components/status-dot";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { canStartHost } from "../../connection/local-host";
import { BusyList } from "./busy-list";
import {
  downloadPercent,
  megabytes,
  resultLabel,
  resultNotice,
  resultTone,
  UpdateNotice,
  UpdateSteps,
} from "./progress";

/** A release row (its name, notes and action), and its status column off phones. */
export const releaseRow = 72;
export const statusWidth = 148;

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

export function HostRelease(props: { update: HostUpdate; phone: boolean }) {
  const host = useHost();
  const c = colors();
  const {
    version,
    offer,
    canUpdate,
    result,
    starting,
    updateNow,
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
    if (active() || starting()) return "blue";
    const ended = result();
    if (ended && ended.state !== "done") {
      const tone = resultTone(ended);
      return tone === "faint" ? "strong" : tone;
    }
    if (check()?.error) return "red";
    if (offer()) return "blue";
    if (check()?.blocked || check()?.heldOnPrerelease) return "warning";
    return "green";
  };
  const percent = () => downloadPercent(status()?.download);
  const statusLabel = () => {
    if (starting()) return uiText("updateStarting");
    if (active()) {
      if (status()!.phase === "downloading" && percent() !== undefined)
        return uiText("updateDownloadingPercent", { percent: percent() });
      return uiText(phaseName[status()!.phase]);
    }
    const ended = result();
    if (ended && ended.state !== "done") return resultLabel(ended);
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
  const offerLabel = () => {
    const latest = check()?.latest ?? "";
    const ended = result();
    if (ended?.state === "rolled-back" && ended.to === latest)
      return uiText("updateTryVersionAgain", { version: latest });
    if (ended?.state === "failed" || ended?.state === "lost")
      return uiText("updateTryAgain");
    return uiText("updateToVersion", { version: latest });
  };
  const waitingOnWork = () =>
    phase() === "waiting" && (status()?.busy?.length ?? 0) > 0;
  const progressDetail = () => {
    if (starting() || phase() === "starting")
      return uiText("updateStartingDetail");
    const download = status()?.download;
    if (phase() === "downloading" && download)
      return download.total
        ? uiText("updateDownloadedOf", {
            received: megabytes(download.received),
            total: megabytes(download.total),
          })
        : uiText("updateDownloadedSome", {
            received: megabytes(download.received),
          });
    return undefined;
  };
  const note = () => check()?.notes;
  /** The status would only say an update is available: its button says it instead. */
  const offered = () =>
    offer() &&
    !active() &&
    !starting() &&
    !check()?.error &&
    (result()?.state ?? "done") === "done";
  const updateAction = () => (
    <If
      when={active() || starting()}
      else={
        <If when={offer()}>
          <Button
            label={offerLabel()}
            size={props.phone ? control.touch : undefined}
            style={
              props.phone
                ? { marginTop: space[8], alignSelf: "stretch" }
                : undefined
            }
            disabled={!canUpdate()}
            onPress={() => {
              error.set("");
              confirm.set(true);
            }}
          />
        </If>
      }
    >
      <View
        style={{
          ...(props.phone ? {} : { alignItems: "flex-start" }),
          gap: props.phone ? space[8] : space[4],
          marginTop: props.phone ? space[8] : 0,
        }}
      >
        <If when={waitingOnWork() && host.can("upgrade.start")}>
          <Button
            label={uiText("updateNow")}
            size={props.phone ? control.touch : undefined}
            disabled={!connected() || !!pending()}
            onPress={() => void updateNow()}
          />
        </If>
        <If when={starting() || canCancel()}>
          <Button
            label={uiText("cancelUpdate")}
            size={props.phone ? control.touch : undefined}
            disabled={!connected() || !!pending() || starting()}
            onPress={() => void request("cancel", {})}
          />
        </If>
      </View>
    </If>
  );

  return (
    <>
      <View
        style={{
          ...(props.phone ? {} : row),
          alignItems: props.phone ? "stretch" : "flex-start",
          gap: props.phone ? space[4] : space[8],
          minHeight: releaseRow,
          paddingVertical: space[8],
          paddingHorizontal: space[16],
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={!props.phone}>
          <View
            style={{
              width: space[24],
              height: space[24],
              flexShrink: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="arrowCircleUp" tone="muted" size={icon.md} />
          </View>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <View testID="host-version">
            <Label weight={weight.regular}>{version()}</Label>
          </View>
          <If when={props.phone && !offered()}>
            <View style={{ ...row, gap: space[4] }}>
              <StatusDot color={c()[statusTone()]} />
              <Label variant="small" tone="mutedInk">
                {statusLabel()}
              </Label>
            </View>
          </If>
          <Label variant="small" tone="muted">
            {desktopTitle()}
          </Label>
          <If when={offer() && note() && !active()}>
            <View
              role="button"
              accessibilityState={{ expanded: notes() }}
              onPress={() => notes.set(!notes())}
              style={{
                ...row,
                gap: space[4],
                alignSelf: "flex-start",
                cursor: "pointer",
              }}
            >
              <Label variant="small" tone="mutedInk">
                {uiText("whatsNew")}
              </Label>
              <Icon
                name={notes() ? "down" : "right"}
                size={icon.sm}
                tone="muted"
              />
            </View>
          </If>
        </View>
        <If
          when={props.phone}
          else={
            <View
              style={{
                width: statusWidth,
                alignItems: "flex-start",
                gap: space[8],
              }}
            >
              <If when={!offered()}>
                <View style={{ ...row, gap: space[4] }}>
                  <StatusDot color={c()[statusTone()]} />
                  <Label variant="small" tone="mutedInk">
                    {statusLabel()}
                  </Label>
                </View>
              </If>
              {updateAction()}
            </View>
          }
        >
          <If when={active() || starting() || offer()}>
            <View style={{ alignItems: "stretch" }}>{updateAction()}</View>
          </If>
        </If>
      </View>
      <If when={notes() && offer() && !active() ? note() : undefined}>
        {(release) => (
          <View
            style={{
              padding: space[16],
              gap: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <chatText.View
              text={{ text: release().text }}
              label={uiText("releaseNotes")}
            />
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
      <If when={active() || starting()}>
        <View
          testID="update-progress"
          style={{
            paddingTop: space[4],
            paddingBottom: space[12],
            paddingLeft: props.phone
              ? space[16]
              : space[16] + space[24] + space[8],
            paddingRight: space[16],
            gap: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <UpdateSteps
            phase={starting() ? "starting" : status()!.phase}
            percent={phase() === "downloading" ? percent() : undefined}
          />
          <If when={progressDetail()}>
            {(detail) => (
              <Label variant="small" tone="mutedInk">
                {detail()}
              </Label>
            )}
          </If>
          <If when={phase() === "waiting"}>
            <BusyList
              work={status()?.busy ?? []}
              label={uiText("waitingFor")}
            />
          </If>
        </View>
      </If>
      {/* A new version is told by a toast (host-restart.tsx); what went wrong stays here. */}
      <If
        when={
          !active() && !starting() && result()?.state !== "done"
            ? result()
            : undefined
        }
      >
        {(ended) => (
          <View
            style={{
              paddingBottom: space[12],
              paddingLeft: props.phone
                ? space[16]
                : space[16] + space[24] + space[8],
              paddingRight: space[16],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <UpdateNotice
              testID="update-result"
              tone={resultTone(ended())}
              title={resultNotice(ended()).title}
              body={resultNotice(ended()).body}
            />
          </View>
        )}
      </If>
      <If
        when={
          (error() && !editor() && !confirm()) ||
          check()?.error ||
          check()?.blocked
        }
      >
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            gap: space[2],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <If when={(error() && !editor() && !confirm()) || check()?.error}>
            <Label variant="small" tone="red">
              {(error() && !editor() && !confirm() ? error() : "") ||
                check()?.error}
            </Label>
          </If>
          <If when={check()?.blocked}>
            {(blocked) => (
              <Label variant="small" tone="muted">
                {uiText(blockedExplanation[blocked()])}
              </Label>
            )}
          </If>
        </View>
      </If>
    </>
  );
}
