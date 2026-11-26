import type { JSX } from "nsh";
import type { HostUpdate } from "./host-update";
import { View } from "nsh";
import {
  Button,
  colors,
  focusRing,
  fontFamily,
  Fonts,
  Icon,
  Label,
  row,
  textFaces,
} from "../../../components";
import { LayoutSelect } from "../../../components/select";
import { control, icon, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { clientPlatform } from "../../../services/client-update";
import { useHost } from "../../../services/host";
import { ClientChannelSelect } from "./client-app";
import { GroupHeading } from "./group-heading";

/** A setting row, and the channel menu with one of its items. */
const settingRow = 56;
const channelWidth = 160;
const itemRow = 28;

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
  const type = textFaces();
  const fonts = Fonts();
  const host = useHost();
  const { advanced, check, source, token, editable, save, edit } = props.update;
  const advancedOpen = () =>
    advanced() ??
    ((!!source() && source()!.source !== "build") || !!check()?.error);
  const channelName = () =>
    check()?.prerelease
      ? uiText("updatePreReleases")
      : uiText("updateFullReleases");
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
      <If when={check() || clientPlatform === "desktop"}>
        <GroupHeading title={uiText("whichVersions")} phone={props.phone} />
        <If when={check()}>
          <ChannelRow title={uiText("channelHost")} phone={props.phone}>
            <LayoutSelect
              accessibilityLabel={uiText("channel")}
              items={[
                { value: "full", title: uiText("updateFullReleases") },
                { value: "pre", title: uiText("updatePreReleases") },
              ]}
              value={check()?.prerelease ? "pre" : "full"}
              cover={false}
              offset={2}
              disabled={!editable() || !host.can("upgrade.setPrerelease")}
              popupStyle={{
                borderWidth: 1,
                borderColor: c().strong,
                backgroundColor: c().canvas,
              }}
              itemStyle={{
                fontFamily: fontFamily(fonts().interface),
                color: c().ink,
                fontSize: type("small").size,
                minHeight: itemRow,
                paddingHorizontal: space[12],
              }}
              trigger={
                <View
                  style={{
                    ...row,
                    height: props.phone ? space[32] : space[24],
                    gap: space[4],
                    paddingHorizontal: space[12],
                    borderWidth: 1,
                    borderColor: c().strong,
                    backgroundColor: c().canvas,
                  }}
                >
                  <Label variant="small" lines={1} style={{ flex: 1 }}>
                    {channelName()}
                  </Label>
                  <Icon name="down" size={icon.sm} tone="muted" />
                </View>
              }
              onChange={({ value }) => {
                if (value && (value === "pre") !== check()?.prerelease)
                  void save("setPrerelease", { prerelease: value === "pre" });
              }}
            />
          </ChannelRow>
        </If>
        <If when={clientPlatform === "desktop"}>
          <ChannelRow title={uiText("desktopApp")} phone={props.phone}>
            <ClientChannelSelect phone={props.phone} />
          </ChannelRow>
        </If>
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label variant="small" tone="muted">
            {uiText("preReleasesRcBetaGetNew")}
          </Label>
        </View>
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
