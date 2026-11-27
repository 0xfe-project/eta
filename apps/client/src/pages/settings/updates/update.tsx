import type { Layout } from "../../../components";
import { View } from "nsh";
import { Button, grow, Label, row, SmoothScroll } from "../../../components";
import { control, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { clientUpdatable, clientUpdate } from "../../../services/client-update";
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
  const phone = () => props.layout === "phone";
  const update = useHostUpdate();
  const { checkedAt, checkedLabel, pending, canRead, active, refresh } = update;
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
            icon="refresh"
            spinIcon
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
        <HostRelease
          update={update}
          phone={phone()}
          onConnect={props.onConnect}
        />
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
