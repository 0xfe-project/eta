import type { PluginView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { Scroll, View } from "nsh";
import { Button, colors, grow, Header, Label, row } from "../../components";
import { uiText } from "../../i18n";

import { pluginText as text } from "./labels";
import { PluginGlyph, Status } from "./plugin-status";
export function PluginTablet(props: {
  items: PluginView[];
  current?: PluginView;
  tabs: JSX.Element;
  onSelect: (name: string) => void;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  detail: JSX.Element;
}) {
  const c = colors();
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <View
        style={{ width: 320, borderRightWidth: 1, borderColor: c().border }}
      >
        <Header
          title={uiText("plugins")}
          count={props.items.length}
          layout="tablet"
          inset={14}
        >
          <View style={{ flex: 1 }} />
          <Button
            label={uiText("refreshPlugins")}
            icon="refresh"
            iconOnly
            onPress={() => void props.onRefresh()}
          />
          <Button
            label={uiText("addFromGit")}
            icon="plus"
            labelSize={11}
            onPress={props.onAdd}
          />
        </Header>
        {props.tabs}
        <Scroll style={grow} scrollbar={false}>
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
                focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
                style={{
                  ...row,
                  gap: 10,
                  height: 60,
                  paddingHorizontal: 14,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                  backgroundColor:
                    props.current?.name === item().name
                      ? c().selected
                      : c().canvas,
                  cursor: "pointer",
                }}
              >
                <PluginGlyph size={28} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Label size={13} line={18} lines={1}>
                    {item().name}
                  </Label>
                  <Label size={10} line={14} tone="muted" lines={1}>
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
            <Label size={12} tone="muted" style={{ padding: 14 }}>
              {uiText("noPluginsInstalled")}
            </Label>
          </If>
        </Scroll>
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            paddingHorizontal: 14,
            paddingVertical: 12,
          }}
        >
          <Label size={10} line={14} tone="muted">
            {uiText("pluginsIntroShort")}
          </Label>
        </View>
      </View>
      <If
        when={props.current}
        else={
          <Label tone="muted" style={{ padding: 20 }}>
            {text("select")}
          </Label>
        }
      >
        {props.detail}
      </If>
    </View>
  );
}
