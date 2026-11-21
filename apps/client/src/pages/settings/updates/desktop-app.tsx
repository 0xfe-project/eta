import type { UpgradeCheckView } from "@eta/client-contracts";
import type { AppUpdate, UpdateProgress } from "nsh/updater";
import { appInfo, openUrl, Scroll, signal, View } from "nsh";
import { checkForUpdate, downloadUpdate, installAndRestart } from "nsh/updater";
import { Button, colors, grow, Label, Modal, row } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

import { BusyList } from "./busy-list";

export function DesktopAppUpdate(props: { work: UpgradeCheckView["busy"] }) {
  const c = colors();
  const host = useHost();
  const update = signal<AppUpdate | undefined>(undefined);
  const checked = signal(false);
  const checking = signal(false);
  const progress = signal<UpdateProgress | undefined>(undefined);
  const ready = signal(false);
  const busy = signal(false);
  const confirm = signal(false);
  const failure = signal("");
  async function check() {
    if (checking() || busy()) return;
    checking.set(true);
    checked.set(false);
    failure.set("");
    ready.set(false);
    update.set(undefined);
    try {
      update.set((await checkForUpdate()) ?? undefined);
      checked.set(true);
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      checking.set(false);
    }
  }
  async function download() {
    const next = update();
    if (!next || busy()) return;
    if (!next.canInstall) {
      await host.action(() => openUrl(next.url));
      return;
    }
    busy.set(true);
    failure.set("");
    try {
      await downloadUpdate(progress.set);
      ready.set(true);
      confirm.set(true);
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
    } finally {
      progress.set(undefined);
      busy.set(false);
    }
  }
  async function restart() {
    if (busy()) return;
    busy.set(true);
    try {
      await installAndRestart();
    } catch (error) {
      failure.set(error instanceof Error ? error.message : String(error));
      confirm.set(false);
    } finally {
      busy.set(false);
    }
  }
  const percentage = () => {
    const current = progress();
    return current?.total
      ? Math.round((100 * current.received) / current.total)
      : undefined;
  };
  return (
    <View
      style={{
        padding: 16,
        gap: 9,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, gap: 8 }}>
        <Label weight={600} style={{ flex: 1 }}>
          {uiText("desktopApp")}
        </Label>
        <Label variant="small" tone="muted">
          {appInfo().version ?? "dev"}
        </Label>
        <Button
          label={
            checking()
              ? uiText("checking")
              : checked()
                ? uiText("checkAgain")
                : uiText("checkDesktopApp")
          }
          disabled={checking() || busy()}
          onPress={() => void check()}
        />
      </View>
      <If when={checked() && !update()}>
        <Label variant="small" tone="muted">
          {uiText("noDesktopAppUpdateAvailable")}
        </Label>
      </If>
      <If when={update()}>
        {(next) => (
          <View style={{ ...row, gap: 8 }}>
            <Label variant="small" style={{ flex: 1 }}>
              {uiText("versionAvailable", { version: next().version })}
            </Label>
            <Button
              disabled={busy()}
              label={
                busy()
                  ? percentage() === undefined
                    ? uiText("downloading")
                    : uiText("downloadingWithCount", {
                        percentage: percentage(),
                      })
                  : ready()
                    ? uiText("restartToUpdate")
                    : next().canInstall
                      ? uiText("downloadUpdate")
                      : uiText("openDownload")
              }
              onPress={() => (ready() ? confirm.set(true) : void download())}
            />
          </View>
        )}
      </If>
      <If when={failure()}>
        <Label variant="small" tone="red">
          {failure()}
        </Label>
      </If>
      <If when={confirm() && update()}>
        <Modal
          title={uiText("updateTheDesktopAppTo", {
            version: update()!.version,
          })}
          width={448}
          height={250}
          hideHeader
          modalFocus
          blurBackdrop={false}
          dismissible={!busy()}
          onClose={() => confirm.set(false)}
        >
          <View style={{ ...grow, padding: 20, gap: 10 }}>
            <Label weight={500}>
              {uiText("updateTheDesktopAppTo", { version: update()!.version })}
            </Label>
            <Scroll style={grow}>
              <View style={{ gap: 10 }}>
                <Label variant="small" tone="mutedInk">
                  {host.address()?.local
                    ? uiText("etaQuitsSwapsInTheNew")
                    : uiText("etaQuitsSwapsInTheNewVersion")}
                </Label>
                <If when={host.address()?.local}>
                  <BusyList
                    work={props.work}
                    label={uiText("theRestartWouldStop")}
                  />
                </If>
              </View>
            </Scroll>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button
                label={uiText("cancel")}
                disabled={busy()}
                onPress={() => confirm.set(false)}
              />
              <Button
                label={busy() ? uiText("restarting") : uiText("restartNow")}
                tone="primary"
                disabled={busy()}
                onPress={() => void restart()}
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}
