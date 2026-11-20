import type { ViewStyle } from "nsh";
import { useText } from "../i18n";
import { Button } from "./controls";

interface NavigationButtonProps {
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  iconSize?: number;
  style?: ViewStyle;
}

export function BackButton(props: NavigationButtonProps) {
  const text = useText();
  return (
    <Button
      label={text("back")}
      icon="back"
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
      icon="close"
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
