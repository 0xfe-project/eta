import { Switch } from "nsh/base";
import { colors, row } from "./theme";

export function ToggleSwitch(props: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const c = colors();
  const thumbSize = () => (props.compact ? 10 : 14);
  return (
    <Switch
      accessibilityLabel={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      style={{ flexShrink: 0, cursor: props.disabled ? "default" : "pointer" }}
      disabledStyle={{ opacity: 0.5 }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: 1,
      }}
      trackStyle={{
        ...row,
        width: props.compact ? 30 : 36,
        height: props.compact ? 16 : 20,
        paddingHorizontal: 2,
        justifyContent: props.checked ? "flex-end" : "flex-start",
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: props.checked ? c().button : c().canvas,
      }}
      thumbStyle={{
        width: thumbSize(),
        height: thumbSize(),
        backgroundColor: props.checked ? c().buttonInk : c().faint,
      }}
    />
  );
}
