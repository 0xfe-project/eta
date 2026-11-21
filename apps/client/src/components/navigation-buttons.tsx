import type { ViewStyle } from "nsh";
import type { IconName } from "./icons";
import { useText } from "../i18n";
import { Button } from "./controls";

interface NavigationButtonProps {
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  iconSize?: number;
  /** Replaces the default glyph, such as an arrow on desktop task pages. */
  icon?: IconName;
  style?: ViewStyle;
}

export function BackButton(props: NavigationButtonProps) {
  const text = useText();
  return (
    <Button
      label={text("back")}
      icon={props.icon ?? "back"}
      iconOnly
      tone="ghost"
      onPress={props.onPress}
      disabled={props.disabled}
      size={props.size}
      iconSize={props.iconSize}
      style={props.style}
    />
  );
}

export function CloseButton(props: NavigationButtonProps) {
  const text = useText();
  return (
    <Button
      label={text("close")}
      icon={props.icon ?? "close"}
      iconOnly
      tone="ghost"
      onPress={props.onPress}
      disabled={props.disabled}
      size={props.size}
      iconSize={props.iconSize}
      style={props.style}
    />
  );
}
