import type {
  ClientChannel,
  ClientOffer,
} from "../../../services/client-update";
import { effect, signal, View } from "nsh";
import { BackHandler } from "nsh/mobile";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Icon,
  Label,
  Modal,
  row,
  SmoothScroll,
} from "../../../components";
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import {
  clientPlatform,
  clientUpdate,
  clientVersion,
} from "../../../services/client-update";
import { useHost } from "../../../services/host";
import { BusyList } from "./busy-list";
import { UpdateChannelMenu } from "./channel";
import { releaseRow, ReleaseStatus, statusWidth } from "./host-release";

/** The update dialog's height, and one item of the channel menu. */
const dialogHeight = 248;

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
      width={dialogWidth.md}
      height={dialogHeight}
      hideHeader
      modalFocus
      blurBackdrop={false}
      dismissible={!update.restarting()}
      onClose={props.onClose}
    >
      <View style={{ ...grow, padding: space[20], gap: space[8] }}>
        <Label weight={weight.regular}>
          {uiText("updateTheDesktopAppTo", { version: version() })}
        </Label>
        <SmoothScroll style={grow}>
          <View style={{ gap: space[8] }}>
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
            label={uiText("restartNow")}
            tone="primary"
            busy={update.restarting()}
            onPress={() => void update.restart()}
          />
        </View>
      </View>
    </Modal>
  );
}

/** The desktop app's update channel menu. */
export function ClientChannelSelect() {
  const update = clientUpdate;
  const names: Record<ClientChannel, string> = {
    stable: uiText("updateFullReleases"),
    rc: uiText("updatePreReleases"),
  };
  return (
    <UpdateChannelMenu
      label={uiText("appUpdateChannel")}
      choices={[
        { value: "stable", label: names.stable },
        { value: "rc", label: names.rc },
      ]}
      value={update.channel()}
      disabled={update.downloading() || update.restarting() || update.ready()}
      onChange={(value) => {
        if (value === "stable" || value === "rc") {
          update.changeChannel(value);
          return true;
        }
        return false;
      }}
    />
  );
}

/** This app's own updates: the desktop app replaces itself, the Android app
 * takes a package of its code, or an APK when the code needs a newer one.
 * The row reads as the Host's does: version, product and machine, status. */
export function ClientAppUpdate(props: { phone: boolean }) {
  const c = colors();
  const update = clientUpdate;
  const confirm = signal(false);
  const status = () => {
    if (update.checking())
      return { tone: "blue", label: uiText("updateChecking") } as const;
    if (update.failure() && !update.offer())
      return { tone: "red", label: uiText("updateCheckFailed") } as const;
    if (update.checked() && !update.offer())
      return { tone: "green", label: uiText("updateUpToDate") } as const;
    return undefined;
  };
  const statusLine = () => (
    <If when={update.offer() ? undefined : status()}>
      {(shown) => (
        <ReleaseStatus
          tone={shown().tone}
          label={shown().label}
          checking={update.checking()}
        />
      )}
    </If>
  );
  const action = () => (
    <If when={update.offer()}>
      {(offer) => (
        <If
          when={!update.downloading()}
          else={
            <Label variant="small" tone="muted">
              {clientUpdateAction(offer())}
            </Label>
          }
        >
          <Button
            label={clientUpdateAction(offer())}
            tone={update.ready() ? "primary" : undefined}
            size={props.phone ? control.touch : undefined}
            style={
              props.phone
                ? { marginTop: space[8], alignSelf: "stretch" }
                : undefined
            }
            busy={update.restarting()}
            onPress={() => pressClientUpdate(() => confirm.set(true))}
          />
        </If>
      )}
    </If>
  );
  return (
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
        <Label weight={weight.regular}>{clientVersion() ?? "dev"}</Label>
        <If when={props.phone}>{statusLine()}</If>
        <Label variant="small" tone="muted">
          {clientPlatform === "android"
            ? uiText("androidAppHere")
            : uiText("desktopAppHere")}
        </Label>
        <If when={update.ready() && update.offer()?.kind === "package"}>
          <Label variant="small" tone="muted">
            {uiText("reopenEtaToUse", { version: update.offer()!.version })}
          </Label>
        </If>
        <If when={update.failure() && !confirm()}>
          <Label variant="small" tone="red">
            {update.failure()}
          </Label>
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
            {statusLine()}
            {action()}
          </View>
        }
      >
        {action()}
      </If>
      <If when={confirm()}>
        <ClientUpdateConfirm onClose={() => confirm.set(false)} />
      </If>
    </View>
  );
}
