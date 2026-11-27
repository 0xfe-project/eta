import type { JSX } from "nsh";
import type { HostUpdate } from "./host-update";
import { View } from "nsh";
import {
  Button,
  colors,
  focusRing,
  Icon,
  Label,
  row,
} from "../../../components";
import { control, icon, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { clientPlatform } from "../../../services/client-update";
import { useHost } from "../../../services/host";
import { UpdateChannelMenu } from "./channel";
import { ClientChannelSelect } from "./client-app";
import { GroupHeading } from "./group-heading";

/** A setting row, and the channel menu with one of its items. */
const settingRow = 56;
const channelWidth = 160;

function SettingBand(props: {
  title: string;
  detail: string;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        gap: space[8],
        minHeight: settingRow,
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label>{props.title}</Label>
        <Label variant="small" tone="muted">
          {props.detail}
        </Label>
      </View>
      {props.children}
    </View>
  );
}

/** One product's channel: its name, and the menu beside it or, on phones, under it. */
function ChannelRow(props: {
  title: string;
  phone: boolean;
  children: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...(props.phone ? {} : row),
        minHeight: props.phone ? undefined : settingRow,
        gap: props.phone ? space[4] : space[12],
        paddingHorizontal: space[16],
        paddingVertical: space[8],
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label style={props.phone ? undefined : { flex: 1, minWidth: 0 }}>
        {props.title}
      </Label>
      <View
        style={{ width: props.phone ? "100%" : channelWidth, flexShrink: 0 }}
      >
        {props.children}
      </View>
    </View>
  );
}

export function ReleaseSettings(props: { update: HostUpdate; phone: boolean }) {
  const c = colors();
  const host = useHost();
  const {
    advanced,
    check,
    source,
    token,
    editable,
    channelEditable,
    connected,
    save,
    edit,
  } = props.update;
  const advancedOpen = () =>
    advanced() ??
    ((!!source() && source()!.source !== "build") || !!check()?.error);
  const sourceKind = () =>
    source()?.source === "env"
      ? uiText("updateEnvironment")
      : source()?.source === "setting"
        ? uiText("updateSettingsSource")
        : uiText("updateDefaultSource");
  const tokenKind = () =>
    token()?.from === "Settings"
      ? uiText("updateTokenSaved")
      : token()?.from === "gh"
        ? "GitHub CLI"
        : (token()?.from ?? uiText("updateNoToken"));
  const tokenHint = () => {
    const credential = token();
    if (!credential?.saved || credential.from === "Settings")
      return uiText("updatePrivateTokenHint");
    return credential.saved !== credential.host
      ? uiText("updateTokenOtherHost", { host: credential.saved })
      : uiText("updateTokenPriority", {
          source: credential.from ?? uiText("updateTokenEnvironment"),
        });
  };

  return (
    <>
      <GroupHeading title={uiText("whichVersions")} phone={props.phone} />
      <View style={{ paddingHorizontal: space[16], paddingVertical: space[8] }}>
        <Label variant="small" tone="muted">
          {uiText("preReleasesRcBetaGetNew")}
        </Label>
      </View>
      <ChannelRow title={uiText("channelHost")} phone={props.phone}>
        <View style={{ gap: space[4] }}>
          <UpdateChannelMenu
            label={uiText("channel")}
            choices={[
              { value: "full", label: uiText("updateFullReleases") },
              { value: "pre", label: uiText("updatePreReleases") },
            ]}
            value={check()?.prerelease ? "pre" : "full"}
            disabled={!channelEditable()}
            onChange={(value) => {
              if ((value === "pre") !== check()?.prerelease)
                return save("setPrerelease", { prerelease: value === "pre" });
              return true;
            }}
          />
          <If when={connected() && !host.can("upgrade.setPrerelease")}>
            <Label variant="small" tone="muted">
              {uiText("updateChannelUnsupported")}
            </Label>
          </If>
        </View>
      </ChannelRow>
      <If when={clientPlatform === "desktop"}>
        <ChannelRow title={uiText("desktopApp")} phone={props.phone}>
          <ClientChannelSelect />
        </ChannelRow>
      </If>
      <If when={check()}>
        <GroupHeading
          title={uiText("whereUpdatesComeFrom")}
          phone={props.phone}
        >
          <View
            role="button"
            accessibilityLabel={uiText("advanced")}
            accessibilityState={{ expanded: advancedOpen() }}
            onPress={() => advanced.set(!advancedOpen())}
            hoverStyle={{ backgroundColor: c().selected }}
            focusVisibleStyle={focusRing(c(), "inset")}
            style={{
              ...row,
              height: props.phone ? control.md : space[24],
              width: space[24],
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <View
              style={{
                transform: advancedOpen() ? [{ rotate: "180deg" }] : undefined,
              }}
            >
              <Icon name="down" size={icon.sm} tone="muted" />
            </View>
          </View>
        </GroupHeading>
        <If when={advancedOpen() ? source() : undefined}>
          {(upstream) => (
            <SettingBand
              title={uiText("updatesFrom")}
              detail={`${upstream().label} · ${sourceKind()}`}
            >
              <If
                when={
                  upstream().source !== "env" && host.can("upgrade.setUpstream")
                }
              >
                <Button
                  label={uiText("change")}
                  disabled={!editable()}
                  onPress={() => edit("upstream")}
                />
              </If>
            </SettingBand>
          )}
        </If>
        <If when={advancedOpen() && token()?.host}>
          <SettingBand
            title={uiText("accessToken")}
            detail={`${tokenKind()} · ${tokenHint()}`}
          >
            <If when={host.can("upgrade.setToken")}>
              <Button
                label={token()?.saved ? uiText("change") : uiText("set")}
                disabled={!editable()}
                onPress={() => edit("token")}
              />
            </If>
          </SettingBand>
        </If>
      </If>
    </>
  );
}
