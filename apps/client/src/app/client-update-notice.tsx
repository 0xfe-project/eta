import { signal, View } from "nsh";
import { Button, colors, Label, row } from "../components";
import { control, icon, space } from "../components/tokens";
import { uiText } from "../i18n";
import {
  clientUpdateAction,
  ClientUpdateConfirm,
  pressClientUpdate,
} from "../pages/settings/updates/client-app";
import { clientUpdate } from "../services/client-update";

/** A strip along the bottom once the start-up check found a newer app: one
 * button to download it and then restart into it, and one to put it off.
 * Closed, it stays closed for that version; the Update settings still offer
 * it. */
export function ClientUpdateNotice() {
  const c = colors();
  const update = clientUpdate;
  const confirm = signal(false);
  const message = () => {
    const offer = update.notice();
    if (!offer) return "";
    if (update.failure()) return update.failure();
    if (offer.kind === "app" && !offer.update.canInstall)
      return uiText("appUpdateNeedsApk", { version: offer.version });
    // The button says what comes next: a restart, or closing the app.
    if (update.ready())
      return uiText("appUpdateReady", { version: offer.version });
    return uiText("appUpdateAvailable", { version: offer.version });
  };
  return (
    <If when={update.notice()}>
      {(offer) => (
        <View
          android={{ accessibilityLiveRegion: "polite" }}
          testID="client-update-notice"
          style={{
            ...row,
            flexShrink: 0,
            minHeight: space[40],
            paddingLeft: space[16],
            paddingRight: space[4],
            borderTopWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            gap: space[8],
          }}
        >
          <Label
            variant="small"
            tone={update.failure() ? "red" : undefined}
            style={{ flex: 1, paddingVertical: space[8] }}
          >
            {message()}
          </Label>
          <Button
            label={clientUpdateAction(offer())}
            tone="primary"
            disabled={update.downloading() || update.restarting()}
            onPress={() => pressClientUpdate(() => confirm.set(true))}
          />
          <Button
            label={uiText("dismissAppUpdate")}
            icon="close"
            iconOnly
            size={control.lg}
            iconSize={icon.md}
            tone="ghost"
            disabled={update.downloading() || update.restarting()}
            onPress={() => update.dismiss()}
          />
          <If when={confirm()}>
            <ClientUpdateConfirm onClose={() => confirm.set(false)} />
          </If>
        </View>
      )}
    </If>
  );
}
