import type { PluginView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { View } from "nsh";
import {
  Button,
  colors,
  grow,
  Header,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { uiText } from "../../i18n";
import { PluginName } from "./plugin-name";
import { NoPlugins, PluginGlyph, Status } from "./plugin-status";

export function PluginTablet(props: {
  items: PluginView[];
  current?: PluginView;
  tabs: JSX.Element;
  onSelect: (name: string) => void;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  detail: JSX.Element;
  /** Under the list, in the same column. */
  extra?: JSX.Element;
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
          background="canvas"
          inset={14}
          end={10}
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
                  opacity: item().enabled ? 1 : 0.55,
                }}
              >
                <PluginGlyph size={28} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
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
            <NoPlugins width={240} />
          </If>
          {props.extra}
        </SmoothScroll>
        <View
          style={{
            borderTopWidth: 1,
            borderColor: c().border,
            paddingHorizontal: 14,
            paddingVertical: 12,
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
                height: 40,
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
