import type { Layout } from "../../components";
import { Button } from "../../components";
import { control, icon } from "../../components/tokens";
import { uiText } from "../../i18n";

/** In a plugins header, opens Settings on the plugin sources. Styled as the header's refresh button. */
export function PluginSettingsButton(props: {
  layout: Layout;
  onPress: () => void;
}) {
  const label = uiText("pluginMarketSettings");
  return props.layout === "phone" ? (
    <Button
      label={label}
      icon="settings"
      iconOnly
      iconSize={icon.md}
      size={control.lg}
      onPress={props.onPress}
    />
  ) : props.layout === "tablet" ? (
    <Button label={label} icon="settings" iconOnly onPress={props.onPress} />
  ) : (
    <Button
      label={label}
      icon="settings"
      iconOnly
      iconSize={icon.md}
      size={control.sm}
      style={{ paddingHorizontal: 0 }}
      tone="ghost"
      onPress={props.onPress}
    />
  );
}
