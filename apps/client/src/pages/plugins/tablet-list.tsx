import type { PluginView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  focusRing,
  grow,
  Header,
  Label,
  row,
  sizes,
  SmoothScroll,
} from "../../components";
import { avatar, opacity, space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { PluginName } from "./plugin-name";
import { NoPlugins, PluginGlyph, Status } from "./plugin-status";
import { PluginSettingsButton } from "./settings-button";

/** A plugin's row in the tablet list. */
const rowHeight = 60;

export function PluginTablet(props: {
  items: PluginView[];
  current?: PluginView;
  tabs: JSX.Element;
  onSelect: (name: string) => void;
  onRefresh: () => Promise<void>;
  onSettings: () => void;
  onAdd: () => void;
  onMarket: () => void;
  detail: JSX.Element;
  /** Under the list, in the same column. */
  extra?: JSX.Element;
}) {
  const c = colors();
  const refreshing = signal(false);
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <View
        style={{
          width: sizes.tabletList,
          borderRightWidth: 1,
          borderColor: c().border,
        }}
      >
        <Header
          title={uiText("plugins")}
          count={props.items.length}
          layout="tablet"
          background="canvas"
          inset={space[16]}
          end={space[12]}
        >
          <View style={{ flex: 1 }} />
          <PluginSettingsButton layout="tablet" onPress={props.onSettings} />
          <Button
            label={uiText("refreshPlugins")}
            icon="refresh"
            spinIcon
            busy={refreshing()}
            iconOnly
            onPress={() => {
              refreshing.set(true);
              void props.onRefresh().finally(() => refreshing.set(false));
            }}
          />
          <Button
            label={uiText("addFromGit")}
            icon="plus"
            labelVariant="caption"
            onPress={props.onAdd}
          />
        </Header>
        {props.tabs}
        <SmoothScroll style={grow} scrollbar={false}>
          <Each of={props.items} key={(item) => item.name}>
            {(item) => (
              <View
                role="button"
                accessibilityLabel={item().name}
                accessibilityState={{
                  selected: props.current?.name === item().name,
                }}
                onPress={() => props.onSelect(item().name)}
                hoverStyle={{ backgroundColor: c().selected }}
                focusVisibleStyle={focusRing(c(), "inset")}
                style={{
                  ...row,
                  gap: space[8],
                  height: rowHeight,
                  paddingHorizontal: space[16],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  backgroundColor:
                    props.current?.name === item().name
                      ? c().selected
                      : c().canvas,
                  cursor: "pointer",
                  opacity: item().enabled ? 1 : opacity.muted,
                }}
              >
                <PluginGlyph size={avatar.lg} />
                <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                  <PluginName name={item().name} />
                  <Label variant="caption" tone="muted" lines={1}>
                    {[
                      item().version,
                      uiText("skillsMcpServers", {
                        length: item().skills.length,
                        value2: item().servers.length,
                      }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Label>
                </View>
                <Status item={item()} />
              </View>
            )}
          </Each>
          <If when={!props.items.length}>
            <NoPlugins onAdd={props.onAdd} onMarket={props.onMarket} />
          </If>
          {props.extra}
        </SmoothScroll>
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            paddingHorizontal: space[16],
            paddingVertical: space[12],
          }}
        >
          <Label variant="caption" tone="muted">
            {uiText("pluginsIntroShort")}
          </Label>
        </View>
      </View>
      <If
        when={props.current}
        else={
          // No plugins: the detail pane keeps only its blank header bar.
          <View style={grow}>
            <View
              style={{
                height: space[40],
                flexShrink: 0,
                backgroundColor: c().surface,
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            />
          </View>
        }
      >
        {props.detail}
      </If>
    </View>
  );
}
