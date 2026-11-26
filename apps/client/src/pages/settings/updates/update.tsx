import type { Layout } from "../../../components";
import { View } from "nsh";
import { Button, grow, Label, row, SmoothScroll } from "../../../components";
import { control, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { clientUpdatable, clientUpdate } from "../../../services/client-update";
import { useHost } from "../../../services/host";
import { ClientAppUpdate } from "./client-app";
import { ConfirmHostUpdate } from "./confirm-update";
import { GroupHeading } from "./group-heading";
import { HostRelease } from "./host-release";
import { useHostUpdate } from "./host-update";
import { ReleaseSettings } from "./release-settings";
import { UpdateSourceEditor } from "./source-editor";

export function UpdateSettings(props: {
  onConnect: () => void;
  layout: Layout;
}) {
  const host = useHost();
  const phone = () => props.layout === "phone";
  const update = useHostUpdate();
  const {
    check,
    checkedAt,
    checkedLabel,
    pending,
    canRead,
    active,
    refresh,
    connected,
    error,
  } = update;
  const app = clientUpdate;
  const hostCanCheck = () =>
    canRead() && (!pending() || pending() === "check") && !active();
  const appCanCheck = () =>
    clientUpdatable && !app.downloading() && !app.restarting() && !app.ready();
  /** One press checks the Host and, where it updates itself, this app. */
  const checkBoth = () => {
    if (hostCanCheck()) void refresh();
    if (appCanCheck()) void app.check();
  };
  return (
    <View style={grow}>
      <GroupHeading title={uiText("update")} phone={phone()}>
        <View style={{ ...row, gap: space[8] }}>
          <If when={checkedAt()}>
            <Label variant="small" tone="muted">
              {checkedLabel()}
            </Label>
          </If>
          <Button
            label={
              checkedAt() || app.checked()
                ? uiText("checkAgain")
                : uiText("checkForUpdates")
            }
            size={phone() ? control.md : control.sm}
            disabled={!hostCanCheck() && !appCanCheck()}
            busy={pending() === "check" || app.checking()}
            onPress={checkBoth}
          />
        </View>
      </GroupHeading>
      <SmoothScroll style={grow} scrollbar={false}>
        <If
          when={check()}
          else={
            <View style={{ padding: space[16], gap: space[8] }}>
              <Label variant="small" tone="muted">
                {!connected()
                  ? uiText("reconnectToCheckForUpdates")
                  : !host.can("upgrade.check")
                    ? uiText("updatesAreUnavailableForThisHost")
                    : pending()
                      ? uiText("checkingForUpdates")
                      : uiText("updateInformationUnavailable")}
              </Label>
              <If when={error()}>
                <Label variant="small" tone="red">
                  {error()}
                </Label>
              </If>
              <If when={!connected() || !host.can("upgrade.check")}>
                <Button
                  label={uiText("changeHost")}
                  onPress={props.onConnect}
                />
              </If>
            </View>
          }
        >
          <HostRelease update={update} phone={phone()} />
        </If>
        {/* The app updates itself whichever Host it is connected to. */}
        <If when={clientUpdatable}>
          <ClientAppUpdate phone={phone()} />
        </If>
        <ReleaseSettings update={update} phone={phone()} />
      </SmoothScroll>
      <UpdateSourceEditor update={update} phone={phone()} />
      <ConfirmHostUpdate update={update} phone={phone()} />
    </View>
  );
}
