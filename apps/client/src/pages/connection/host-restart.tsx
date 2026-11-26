import type { UpgradePhase, UpgradeStatusView } from "@eta/client-contracts";
import type { ProgressHandle } from "../../components/progress-notification";
import type { light } from "../../components/theme";
import type { UpgradeResult } from "../settings/updates/progress";
import { cleanup, computed, effect, signal, untracked, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  fill,
  Label,
  NativeDialog,
  row,
} from "../../components";
import { startProgress } from "../../components/progress-notification";
import { screenInsets } from "../../components/safe-area";
import { dotSize, StatusDot } from "../../components/status-dot";
import { showToast } from "../../components/toast";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import {
  downloadPercent,
  megabytes,
  resultNotice,
} from "../settings/updates/progress";

// What covers the whole window while the Host is replaced (Paper: Eta · Settings › Supplement /
// Update flow, full-window screens). Downloading and waiting for work leave the app alone; from
// the moment the service stops nothing behind this works, so it goes over every dialog too. An
// upgrade this window watched is told once when it ends: a new version reconnects, a rollback or a
// Host that needs a hand stays until it is read.

const SERVICE_DOWN = new Set<UpgradePhase>([
  "stopping",
  "backing-up",
  "restarting",
  "verifying",
  "rolling-back",
]);

/** How long the Host may stay away before the screen says that is not normal. */
const SLOW_MS = 5 * 60_000;
/** How long "Updated to …" stays once the new version answers. */
const DONE_MS = 1200;

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type StepState = "done" | "current" | "todo" | "failed" | "restoring";

/** Where a phase is in the steps after the download, 1 to 4. */
const stepOf: Partial<Record<UpgradePhase, number>> = {
  stopping: 1,
  "backing-up": 2,
  restarting: 3,
  verifying: 4,
};

function steps(
  status: UpgradeStatusView,
  downloaded: number | undefined,
): { text: string; state: StepState }[] {
  const to = status.to ?? "";
  const done = status.state === "done";
  const rolling = status.phase === "rolling-back";
  const current = done ? 5 : rolling ? 3 : (stepOf[status.phase] ?? 1);
  const at = (index: number): StepState =>
    index < current ? "done" : index === current ? "current" : "todo";
  const state = (index: number, now: string, then: string) => ({
    text: at(index) === "done" ? then : now,
    state: at(index),
  });
  return [
    {
      text:
        downloaded === undefined
          ? uiText("updateStepDownloadedPlain")
          : uiText("updateStepDownloaded", { size: megabytes(downloaded) }),
      state: "done",
    },
    state(1, uiText("updateStepStopping"), uiText("updateStepStopped")),
    state(2, uiText("updateStepBackingUp"), uiText("updateStepBackedUp")),
    rolling
      ? {
          text: uiText("updateStepDidNotHold", { version: to }),
          state: "failed",
        }
      : state(
          3,
          uiText("updateStepRestarting", { version: to }),
          uiText("updateStepRestarted", { version: to }),
        ),
    rolling
      ? {
          text: uiText("updateStepRestoring", { version: status.from }),
          state: "restoring",
        }
      : state(4, uiText("updateStepChecking"), uiText("updateStepChecked")),
  ];
}

export function HostRestartScreen(props: { onConnect: () => void }) {
  const host = useHost();
  const c = colors();
  const insets = screenInsets();
  const status = host.upgrade;
  const running = () => status()?.state === "running";
  const down = computed(() => {
    const now = status();
    if (now?.state !== "running") return false;
    return (
      SERVICE_DOWN.has(now.phase) ||
      (host.upgradeUnreachable() && host.state().status !== "open")
    );
  });

  // The upgrade this window saw running: an old result is not news.
  const watched = signal<string>();
  const dismissed = signal<string>();
  const downloaded = signal<number>();
  let hostProgress: ProgressHandle | undefined;
  effect(() => {
    const now = status();
    if (now?.state === "running" && now.id !== untracked(watched))
      watched.set(now.id);
    const download = now?.download;
    if (download) downloaded.set(download.total ?? download.received);
  });
  // Mirror non-blocking host upgrade phases (starting / downloading / waiting) into the
  // cross-page top-right ProgressNotification stack; dismiss once the full-window restart screen
  // takes over or the run finishes.
  effect(() => {
    const now = status();
    const inBackground =
      now?.state === "running" &&
      (now.phase === "starting" ||
        now.phase === "downloading" ||
        now.phase === "waiting");
    if (!inBackground) {
      hostProgress?.dismiss();
      hostProgress = undefined;
      return;
    }
    const percent = downloadPercent(now.download);
    const detail =
      now.phase === "downloading" && now.download
        ? now.download.total
          ? uiText("updateDownloadedOf", {
              received: megabytes(now.download.received),
              total: megabytes(now.download.total),
            })
          : uiText("updateDownloadedSome", {
              received: megabytes(now.download.received),
            })
        : now.phase === "waiting"
          ? uiText("updateWaiting")
          : uiText("updatePreparing");
    const onCancel = host.can("upgrade.cancel")
      ? () => {
          hostProgress = undefined;
          void host.call("upgrade", "cancel", {}).catch(() => {});
        }
      : undefined;
    const fraction =
      now.phase === "downloading" && percent !== undefined
        ? percent / 100
        : undefined;
    const title = now.to
      ? uiText("updateToVersion", { version: now.to })
      : uiText("updatingTheHost");
    if (!hostProgress) {
      hostProgress = startProgress({
        id: "host-update",
        icon: "arrowCircleUp",
        title,
        detail,
        progress: fraction,
        onCancel,
      });
    } else {
      hostProgress.update({ title, detail, progress: fraction, onCancel });
    }
  });
  cleanup(() => {
    hostProgress?.dismiss();
    hostProgress = undefined;
  });
  const ended = () => {
    const now = status();
    return now && now.state !== "running" && now.id === watched()
      ? now
      : undefined;
  };
  // Failed or cancelled before the service was touched, or lost: Settings says so, in place.
  const told = () => {
    const now = ended();
    return now &&
      now.id !== dismissed() &&
      (now.state === "done" ||
        now.state === "rolled-back" ||
        now.state === "broken")
      ? now
      : undefined;
  };

  // The clock the screen counts with, and when the Host was last heard from.
  const now = signal(Date.now());
  const shownAt = signal<number>();
  const awaySince = signal<number>();
  let tick: ReturnType<typeof setInterval> | undefined;
  effect(() => {
    const shown = down();
    untracked(() => {
      if (shown && shownAt() === undefined) shownAt.set(Date.now());
      if (!shown) shownAt.set(undefined);
    });
    clearInterval(tick);
    tick = shown ? setInterval(() => now.set(Date.now()), 1000) : undefined;
    now.set(Date.now());
  });
  effect(() => {
    const away = down() && host.upgradeUnreachable();
    untracked(() => {
      if (away && awaySince() === undefined) awaySince.set(Date.now());
      if (!away) awaySince.set(undefined);
    });
  });
  const slow = () => {
    const since = awaySince();
    return since !== undefined && now() - since >= SLOW_MS;
  };

  // A new version: say so, then go back to the app once the socket is open again (the wire
  // reconnects by itself). Only the result and the socket's openness count, not every frame.
  const doneId = computed(() => {
    const result = told();
    return result?.state === "done" ? result.id : undefined;
  });
  const open = computed(() => host.state().status === "open");
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const id = doneId();
    const connected = open();
    clearTimeout(doneTimer);
    if (id && connected)
      doneTimer = setTimeout(() => {
        dismissed.set(id);
        // Back in the app, the result is a toast over it, not a notice in Settings.
        const result = untracked(status);
        if (result?.id === id) showToast(resultNotice(result as UpgradeResult));
      }, DONE_MS);
  });
  cleanup(() => {
    clearInterval(tick);
    clearTimeout(doneTimer);
  });

  const mark = (state: StepState) => {
    if (state === "done")
      return (
        <Label variant="small" tone="green">
          ✓
        </Label>
      );
    const tone: keyof typeof light =
      state === "failed" ? "red" : state === "restoring" ? "warning" : "blue";
    return state === "todo" ? (
      <View
        style={{
          width: dotSize,
          height: dotSize,
          borderWidth: 1,
          borderColor: c().strong,
        }}
      />
    ) : (
      <StatusDot color={c()[tone]} />
    );
  };

  const stepList = (shown: UpgradeStatusView) => (
    <View
      testID="update-screen-steps"
      style={{
        gap: space[4],
        paddingVertical: space[12],
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Each of={steps(shown, downloaded())} key={(step) => step.text}>
        {(step) => (
          <View style={{ ...row, gap: space[8] }}>
            <View style={{ width: space[16], alignItems: "center" }}>
              {mark(step().state)}
            </View>
            <Label
              variant="small"
              tone={
                step().state === "current" || step().state === "restoring"
                  ? "ink"
                  : step().state === "todo"
                    ? "faint"
                    : "muted"
              }
            >
              {step().text}
            </Label>
          </View>
        )}
      </Each>
    </View>
  );

  const shown = () => (down() ? status() : told());

  return (
    <If when={shown()}>
      {(current) => (
        // A dialog of its own: Settings (and any other focused dialog) is a native layer over the
        // window, and only a layer opened after it covers it.
        <NativeDialog
          accessibilityLabel={uiText("hostUpdateInProgress")}
          style={fill}
          animation="none"
          closeOnEscape={false}
          closeOnBackdropPress={false}
          onOpenChange={() => {}}
        >
          <View
            role="alert"
            testID="host-updating"
            accessibilityLabel={uiText("hostUpdateInProgress")}
            style={{
              ...fill,
              // design-value: the update screen covers an open dialog (layer.modal), under toasts
              zIndex: 500,
              backgroundColor: c().canvas,
              justifyContent: "center",
              alignItems: "center",
              paddingTop: insets().top,
              paddingBottom: insets().bottom,
              paddingHorizontal: space[24],
            }}
          >
            <View
              style={{
                width: dialogWidth.md,
                maxWidth: "100%",
                gap: space[16],
              }}
            >
              <>
                <If when={running()}>
                  <View style={{ gap: space[4] }}>
                    <Label variant="subtitle" weight={weight.regular}>
                      {current().to
                        ? uiText("updateScreenTitle", { version: current().to })
                        : uiText("updatingTheHost")}
                    </Label>
                    <Label tone="mutedInk">
                      {slow()
                        ? uiText("updateScreenSlowSub")
                        : current().phase === "rolling-back"
                          ? uiText("updateScreenRollingBack", {
                              version: current().from,
                            })
                          : uiText("updateScreenSub")}
                    </Label>
                  </View>
                  {stepList(current())}
                  <If
                    when={slow()}
                    else={
                      <Label variant="small" tone="muted">
                        {uiText("updateScreenFoot", {
                          elapsed: elapsed(now() - (shownAt() ?? now())),
                        })}
                      </Label>
                    }
                  >
                    <View testID="update-slow" style={{ gap: space[12] }}>
                      <View
                        style={{
                          ...row,
                          alignItems: "flex-start",
                          gap: space[8],
                          paddingVertical: space[8],
                          paddingHorizontal: space[12],
                          borderWidth: 1,
                          borderColor: c().strong,
                        }}
                      >
                        <View style={{ paddingTop: space[4] }}>
                          <StatusDot color={c().warning} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                          <Label variant="small" weight={weight.regular}>
                            {uiText("updateSlowTitle")}
                          </Label>
                          <Label variant="small" tone="mutedInk">
                            {uiText("updateSlowBody")}
                          </Label>
                        </View>
                      </View>
                      <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
                        <Button
                          label={uiText("changeHost")}
                          onPress={props.onConnect}
                        />
                        <Label variant="small" tone="muted">
                          {uiText("updateStillTrying", {
                            elapsed: elapsed(now() - (shownAt() ?? now())),
                          })}
                        </Label>
                      </View>
                    </View>
                  </If>
                </If>
                <If when={current().state === "done"}>
                  <View style={{ gap: space[4] }}>
                    <Label variant="subtitle" weight={weight.regular}>
                      {uiText("updateDoneTitle", {
                        version: current().to ?? "",
                      })}
                    </Label>
                    <Label tone="mutedInk">
                      {uiText("updateScreenReconnecting")}
                    </Label>
                  </View>
                  {stepList(current())}
                  <Label variant="small" tone="muted">
                    {uiText("updateScreenBackSoon")}
                  </Label>
                </If>
                <If when={current().state === "rolled-back"}>
                  <View style={{ gap: space[4] }}>
                    <Label variant="subtitle" weight={weight.regular}>
                      {uiText("updateRolledBackScreenTitle", {
                        version: current().to ?? "",
                      })}
                    </Label>
                    <Label tone="mutedInk">
                      {uiText("updateRolledBackScreenBody", {
                        from: current().from,
                      })}
                    </Label>
                  </View>
                  <View
                    style={{
                      gap: space[12],
                      paddingTop: space[12],
                      borderTopWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <If when={current().error}>
                      {(error) => (
                        <View
                          style={{
                            ...row,
                            alignItems: "flex-start",
                            gap: space[8],
                          }}
                        >
                          <View style={{ paddingTop: space[4] }}>
                            <StatusDot color={c().warning} />
                          </View>
                          <Label
                            variant="small"
                            tone="mutedInk"
                            style={{ flex: 1 }}
                          >
                            {error()}
                          </Label>
                        </View>
                      )}
                    </If>
                    <View style={row}>
                      <Button
                        label={uiText("backToEta")}
                        tone="primary"
                        onPress={() => dismissed.set(current().id)}
                      />
                    </View>
                  </View>
                </If>
                <If when={current().state === "broken"}>
                  <View style={{ gap: space[4] }}>
                    <Label variant="subtitle" weight={weight.regular}>
                      {uiText("updateBrokenTitle")}
                    </Label>
                    <Label tone="mutedInk">
                      {uiText("updateBrokenBody", {
                        to: current().to ?? "",
                        from: current().from,
                      })}
                    </Label>
                  </View>
                  <View
                    style={{
                      gap: space[12],
                      paddingTop: space[12],
                      borderTopWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <If when={current().error}>
                      {(error) => (
                        <View
                          style={{
                            ...row,
                            alignItems: "flex-start",
                            gap: space[8],
                          }}
                        >
                          <View style={{ paddingTop: space[4] }}>
                            <StatusDot color={c().red} />
                          </View>
                          <Label
                            variant="small"
                            tone="mutedInk"
                            style={{ flex: 1 }}
                          >
                            {error()}
                          </Label>
                        </View>
                      )}
                    </If>
                    <View style={{ gap: space[2] }}>
                      <Label variant="small">{uiText("updateWhatToDo")}</Label>
                      <Label variant="small" tone="mutedInk">
                        {uiText("updateBrokenNext")}
                      </Label>
                    </View>
                    <View style={{ ...row, gap: space[8] }}>
                      <Button
                        label={uiText("reconnect")}
                        tone="primary"
                        onPress={() => {
                          dismissed.set(current().id);
                          host.retry();
                        }}
                      />
                      <Button
                        label={uiText("changeHost")}
                        onPress={props.onConnect}
                      />
                    </View>
                  </View>
                </If>
              </>
            </View>
          </View>
        </NativeDialog>
      )}
    </If>
  );
}
