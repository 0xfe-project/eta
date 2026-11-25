import type { TextStyle, ViewStyle } from "nsh";
import { View } from "nsh";
import { control, icon, space } from "../components/tokens";
import { uiText } from "../i18n";
import { Button } from "./button";
import { Field } from "./input";
import { Icon } from "./text";

/**
 * Search input with a trailing search glyph that switches to a clear button while non-empty.
 */
export function SearchField(props: {
  label: string;
  placeholder?: string;
  value: string;
  compact?: boolean;
  clearable?: boolean;
  style?: ViewStyle;
  inputStyle?: TextStyle;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}) {
  const showClear = () => props.clearable !== false && props.value.length > 0;
  return (
    <View style={{ position: "relative", minWidth: 0, ...props.style }}>
      <Field
        label={props.label}
        placeholder={props.placeholder ?? props.label}
        value={props.value}
        compact={props.compact}
        onChange={props.onChange}
        onSubmit={props.onSubmit}
        style={{
          width: "100%",
          paddingRight: space[24],
          ...props.inputStyle,
        }}
      />
      <View
        style={{
          position: "absolute",
          right: showClear() ? space[2] : space[8],
          top: 0,
          bottom: 0,
          justifyContent: "center",
          pointerEvents: showClear() ? "auto" : "none",
        }}
      >
        <If
          when={showClear()}
          else={<Icon name="search" size={icon.sm} tone="muted" />}
        >
          <Button
            label={uiText("close")}
            icon="close"
            iconOnly
            tone="ghost"
            size={control.sm}
            iconSize={icon.sm}
            onPress={() => props.onChange("")}
          />
        </If>
      </View>
    </View>
  );
}
