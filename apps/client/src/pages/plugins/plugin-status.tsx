import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Empty, Icon, Label } from "../../components";
import { icon, space } from "../../components/tokens";
import { uiText } from "../../i18n";

export function PluginGlyph(props: { size: number }) {
  const c = colors();
  return (
    <View
      style={{
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c().selected,
        borderWidth: 1,
        borderColor: c().border,
        flexShrink: 0,
      }}
    >
      <Icon
        name="plugins"
        size={Math.round(props.size * 0.52)}
        tone="mutedInk"
      />
    </View>
  );
}

export function Status(props: { item: PluginView; phone?: boolean }) {
  const c = colors();
  const missing = () => props.item.state === "needs_config";
  return (
    <Label
      variant="caption"
      lines={1}
      tone={missing() ? "warningInk" : "muted"}
      style={{
        alignSelf: props.phone ? "flex-start" : "center",
        paddingHorizontal: missing() ? space[8] : 0,
        paddingVertical: 1,
        borderWidth: missing() ? 1 : 0,
        borderColor: c().warning,
      }}
    >
      {missing() ? uiText("needsConfiguring") : uiText("canBeEnabled")}
    </Label>
  );
}

/** No plugins: the design's empty state, under the intro. */
export function NoPlugins(props: { width: number }) {
  return (
    <Empty
      title={uiText("noPluginsYet")}
      description={uiText("noPluginsHint")}
      icon="plugins"
      iconSize={icon.xl}
      descriptionWidth={props.width}
      style={{
        flex: undefined,
        justifyContent: "flex-start",
        paddingVertical: space[40],
      }}
    />
  );
}
