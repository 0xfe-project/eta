import type { Layout } from "../../../components";
import { Scroll, View } from "nsh";
import { Button, grow, Label, row } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { canStartHost } from "../../connection/local-host";
import { ConfirmHostUpdate } from "./confirm-update";
import { DesktopAppUpdate } from "./desktop-app";
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
  return (
    <View style={grow}>
      <GroupHeading title={uiText("update")} phone={phone()}>
        <View style={{ ...row, gap: 10 }}>
          <If when={checkedAt()}>
            <Label variant="small" tone="muted">
              {checkedLabel()}
            </Label>
          </If>
          <Button
            label={
              pending() === "check"
                ? uiText("checking")
                : checkedAt()
                  ? uiText("checkAgain")
                  : uiText("checkForUpdates")
            }
            size={phone() ? 28 : 24}
            disabled={!canRead() || !!pending() || active()}
            onPress={() => void refresh()}
          />
        </View>
      </GroupHeading>
      <Scroll style={grow} scrollbar={false}>
        <If
          when={check()}
          else={
            <View style={{ padding: 16, gap: 8 }}>
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
          <ReleaseSettings update={update} phone={phone()} />
        </If>
        <If when={canStartHost}>
          <DesktopAppUpdate work={check()?.busy ?? []} />
        </If>
      </Scroll>
      <UpdateSourceEditor update={update} phone={phone()} />
      <ConfirmHostUpdate update={update} phone={phone()} />
    </View>
  );
}
