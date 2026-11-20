import type { PluginView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Icon, Label } from "../../components";
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
      size={10}
      line={14}
      lines={1}
      tone={missing() ? "warningInk" : "muted"}
      style={{
        alignSelf: props.phone ? "flex-start" : "center",
        paddingHorizontal: missing() ? 6 : 0,
        paddingVertical: 1,
        borderWidth: missing() ? 1 : 0,
        borderColor: c().warning,
      }}
    >
      {missing() ? uiText("needsConfiguring") : uiText("canBeEnabled")}
    </Label>
  );
}
