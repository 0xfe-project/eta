import type { JSX, ViewStyle } from "nsh";
import { Checkbox } from "nsh/base";
import { Icon } from "./text";
import { colors } from "./theme";
import { icon } from "./tokens";

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
    <Checkbox
      accessibilityLabel={props.label}
      checked={props.checked}
      role={props.role ?? "checkbox"}
      disabled={props.disabled}
      onChange={({ checked }) => props.onChange(checked)}
      style={props.style}
      hoverStyle={props.hoverStyle}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: c().blue,
        outlineOffset: -1,
      }}
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
    </Checkbox>
  );
}
