import { Switch } from "nsh/base";
import { colors, row } from "./theme";
import { opacity, space } from "./tokens";

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
      disabledStyle={{ opacity: opacity.disabled }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: 1,
      }}
      trackStyle={{
        ...row,
        width: props.compact ? 28 : 36,
        height: props.compact ? space[16] : space[20],
        paddingHorizontal: space[2],
        justifyContent: props.checked ? "flex-end" : "flex-start",
        borderWidth: 1,
        borderColor: props.checked ? c().button : c().strong,
        backgroundColor: props.checked ? c().button : c().canvas,
      }}
      thumbStyle={{
        width: thumbSize(),
        height: thumbSize(),
        // The design's off thumb: muted on the 28px toggle, border-strong on
        // the wide one.
        backgroundColor: props.checked
          ? c().buttonInk
          : props.compact
            ? c().muted
            : c().strong,
      }}
    />
  );
}
