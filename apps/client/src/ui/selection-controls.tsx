import type { JSX, ViewStyle } from "nsh";
import { Checkbox as BaseCheckbox, Switch as BaseSwitch } from "nsh/base";
import { colors, focusRing, row } from "../components/theme";
import { icon, opacity, space } from "../components/tokens";
import { Icon } from "./text";

const trackWidth = { compact: 28, regular: 36 } as const;

export function CheckControl(props: {
  label: string;
  checked: boolean;
  role?: "radio";
  disabled?: boolean;
  size: number;
  markSize?: number;
  outlineOnly?: boolean;
  style?: ViewStyle;
  indicatorStyle?: ViewStyle;
  hoverStyle?: ViewStyle;
  onChange: (checked: boolean) => void;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <BaseCheckbox
      accessibilityLabel={props.label}
      checked={props.checked}
      role={props.role ?? "checkbox"}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      style={props.style}
      hoverStyle={props.hoverStyle}
      focusVisibleStyle={focusRing(c(), "inset")}
      indicatorStyle={{
        width: props.size,
        height: props.size,
        flexShrink: 0,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: props.outlineOnly
          ? "transparent"
          : props.checked
            ? c().button
            : c().canvas,
        alignItems: "center",
        justifyContent: "center",
        ...props.indicatorStyle,
      }}
      indicator={
        <If when={props.checked}>
          <Icon
            name="check"
            size={props.markSize ?? icon.sm}
            tone={props.outlineOnly ? "ink" : "buttonInk"}
          />
        </If>
      }
    >
      {props.children}
    </BaseCheckbox>
  );
}

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
    <BaseSwitch
      accessibilityLabel={props.label}
      checked={props.checked}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      style={{ flexShrink: 0, cursor: props.disabled ? "default" : "pointer" }}
      disabledStyle={{ opacity: opacity.disabled }}
      focusVisibleStyle={focusRing(c())}
      trackStyle={{
        ...row,
        width: props.compact ? trackWidth.compact : trackWidth.regular,
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
        backgroundColor: props.checked
          ? c().buttonInk
          : props.compact
            ? c().muted
            : c().strong,
      }}
    />
  );
}
