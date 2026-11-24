import type {
  ClientChannel,
  ClientOffer,
} from "../../../services/client-update";
import { effect, signal, View } from "nsh";
import { BackHandler } from "nsh/mobile";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
} from "../../../components";
import { DownloadProgressBar } from "../../../components/download-progress";
import { LayoutSelect } from "../../../components/select";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import {
  clientPlatform,
  clientUpdate,
  clientVersion,
} from "../../../services/client-update";
import { useHost } from "../../../services/host";

import { BusyList } from "./busy-list";

/** What the offer's one button says, from finding it to restarting into it. */
export function clientUpdateAction(offer: ClientOffer) {
  const update = clientUpdate;
  if (update.downloading()) {
    const percentage = update.percentage();
    return percentage === undefined
      ? uiText("downloading")
      : uiText("downloadingWithCount", { percentage });
  }
  if (update.ready())
    return offer.kind === "package"
      ? uiText("closeEtaToUpdate")
      : update.restarting()
        ? uiText("restarting")
        : uiText("restartToUpdate");
  if (offer.kind === "app" && !offer.update.canInstall)
    return uiText("downloadApk");
  return uiText("downloadUpdate");
}

/** Download, then restart: the desktop asks first, Android closes the app,
 * which runs the package from its next start. */
export function pressClientUpdate(confirm: () => void) {
  const update = clientUpdate;
  const offer = update.offer();
  if (!offer || update.busy()) return;
  if (!update.ready()) {
    void update.download();
    return;
  }
  if (offer.kind === "package") BackHandler.exitApp();
  else confirm();
}

/** Asks before the desktop app quits for its new version: what a local Host
 * would stop with it, as the Host's own update does. */
export function ClientUpdateConfirm(props: { onClose: () => void }) {
  const host = useHost();
  const update = clientUpdate;
  const local = () => !!host.address()?.local;
  effect(() => {
    // The list of running work comes with the Host's update check.
    if (local() && host.state().status === "open" && host.can("upgrade.check"))
      void host.checkUpgrade().catch(() => {});
  });
  const version = () => update.offer()?.version ?? "";
  return (
    <Modal
      title={uiText("updateTheDesktopAppTo", { version: version() })}
      width={448}
      height={250}
      hideHeader
      modalFocus
      blurBackdrop={false}
      dismissible={!update.restarting()}
      onClose={props.onClose}
    >
      <View style={{ ...grow, padding: space[20], gap: 10 }}>
        <Label weight={weight.regular}>
          {uiText("updateTheDesktopAppTo", { version: version() })}
        </Label>
        <SmoothScroll style={grow}>
          <View style={{ gap: 10 }}>
            <Label variant="small" tone="mutedInk">
              {local()
                ? uiText("etaQuitsSwapsInTheNew")
                : uiText("etaQuitsSwapsInTheNewVersion")}
            </Label>
            <If when={local()}>
              <BusyList
                work={host.upgradeCheck()?.busy ?? []}
                label={uiText("theRestartWouldStop")}
              />
            </If>
            <If when={update.failure()}>
              <Label variant="small" tone="red">
                {update.failure()}
              </Label>
            </If>
          </View>
        </SmoothScroll>
        <View style={{ ...row, justifyContent: "flex-end", gap: space[8] }}>
          <Button
            label={uiText("cancel")}
            disabled={update.restarting()}
            onPress={props.onClose}
          />
          <Button
            label={
              update.restarting() ? uiText("restarting") : uiText("restartNow")
            }
            tone="primary"
            disabled={update.restarting()}
            onPress={() => void update.restart()}
          />
        </View>
      </View>
    </Modal>
  );
}

function ChannelSelect(props: { phone: boolean }) {
  const c = colors();
  const type = textFaces();
  const update = clientUpdate;
  const names: Record<ClientChannel, string> = {
    stable: uiText("updateFullReleases"),
    rc: uiText("updatePreReleases"),
  };
  return (
    <View
      style={{
        ...(props.phone ? {} : row),
        gap: props.phone ? 4 : 14,
      }}
    >
      <View
        style={{
          flex: props.phone ? undefined : 1,
          minWidth: 0,
          gap: space[2],
        }}
      >
        <Label variant="small">{uiText("channel")}</Label>
        <Label variant="small" tone="muted">
          {uiText("preReleasesRcBetaGetNew")}
        </Label>
      </View>
      <View style={{ width: props.phone ? "100%" : 160, flexShrink: 0 }}>
        <LayoutSelect
          accessibilityLabel={uiText("appUpdateChannel")}
          items={[
            { value: "stable", title: names.stable },
            { value: "rc", title: names.rc },
          ]}
          value={update.channel()}
          cover={false}
          offset={2}
          disabled={update.busy() || update.ready()}
          popupStyle={{
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
          }}
          itemStyle={{
            color: c().ink,
            fontSize: type("small").size,
            minHeight: 29,
            paddingHorizontal: 10,
          }}
          trigger={
            <View
              style={{
                ...row,
                height: props.phone ? space[32] : space[24],
                gap: 6,
                paddingHorizontal: 10,
                borderWidth: 1,
                borderColor: c().strong,
                backgroundColor: c().canvas,
              }}
            >
              <Label variant="small" lines={1} style={{ flex: 1 }}>
                {names[update.channel()]}
              </Label>
              <Icon name="down" size={icon.sm} tone="muted" />
            </View>
          }
          onChange={({ value }) => {
            if (value === "stable" || value === "rc")
              update.changeChannel(value);
          }}
        />
      </View>
    </View>
  );
}

/** This app's own updates: the desktop app replaces itself, the Android app
 * takes a package of its code, or an APK when the code needs a newer one. */
export function ClientAppUpdate(props: { phone: boolean }) {
  const c = colors();
  const update = clientUpdate;
  const confirm = signal(false);
  return (
    <View
      style={{
        padding: space[16],
        gap: 9,
        borderTopWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, gap: space[8] }}>
        <Label weight={weight.strong} style={{ flex: 1 }}>
          {clientPlatform === "android"
            ? uiText("androidApp")
            : uiText("desktopApp")}
        </Label>
        <Label variant="small" tone="muted">
          {clientVersion() ?? "dev"}
        </Label>
        <Button
          label={
            update.checking()
              ? uiText("checking")
              : update.checked()
                ? uiText("checkAgain")
                : uiText("checkAppUpdate")
          }
          size={props.phone ? control.md : control.sm}
          disabled={update.busy() || update.ready()}
          onPress={() => void update.check()}
        />
      </View>
      <If when={clientPlatform === "desktop"}>
        <ChannelSelect phone={props.phone} />
      </If>
      <If when={update.checked() && !update.offer()}>
        <Label variant="small" tone="muted">
          {uiText("noAppUpdateAvailable")}
        </Label>
      </If>
      <If when={update.offer()}>
        {(offer) => (
          <View style={{ gap: 6 }}>
            <View style={{ ...row, gap: space[8] }}>
              <Label variant="small" style={{ flex: 1 }}>
                {uiText("versionAvailable", { version: offer().version })}
              </Label>
              <Button
                label={clientUpdateAction(offer())}
                tone={update.ready() ? "primary" : undefined}
                disabled={update.downloading() || update.restarting()}
                onPress={() => pressClientUpdate(() => confirm.set(true))}
              />
            </View>
            <If when={update.downloading() ? update.percentage() : undefined}>
              {(value) => <DownloadProgressBar value={value()} />}
            </If>
            <If when={update.ready() && offer().kind === "package"}>
              <Label variant="small" tone="muted">
                {uiText("reopenEtaToUse", { version: offer().version })}
              </Label>
            </If>
          </View>
        )}
      </If>
      <If when={update.failure() && !confirm()}>
        <Label variant="small" tone="red">
          {update.failure()}
        </Label>
      </If>
      <If when={confirm()}>
        <ClientUpdateConfirm onClose={() => confirm.set(false)} />
      </If>
    </View>
  );
}
