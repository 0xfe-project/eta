import type { JSX, TextStyle, ViewRef, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import type { light } from "./theme";
import { View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { pickerTarget } from "./element-picker";
import { Icon, Label } from "./text";
import { colors, fontFamily, Fonts, row } from "./theme";

export function Button(props: {
  label: string;
  icon?: IconName;
  end?: IconName;
  iconOnly?: boolean;
  iconSize?: number;
  tone?: "primary" | "plain" | "ghost" | "danger";
  selected?: boolean;
  disabled?: boolean;
  size?: number;
  labelSize?: number;
  labelWeight?: number;
  dimDisabled?: boolean;
  style?: ViewStyle;
  onPress: () => void;
}) {
  const color = colors();
  const picker = pickerTarget(
    "Button",
    "apps/client/src/components/controls.tsx",
  );
  const primary = () => props.tone === "primary";
  const ghost = () => props.tone === "ghost";
  const textTone = () =>
    primary() ? "buttonInk" : props.tone === "danger" ? "red" : "ink";
  return (
    <View
      {...picker}
      role="button"
      accessibilityLabel={props.label}
      accessibilityState={{
        disabled: props.disabled ?? false,
        selected: props.selected,
      }}
      onPress={() => {
        if (!props.disabled) props.onPress();
      }}
      hoverStyle={{
        backgroundColor: primary() ? color().ink : color().selected,
      }}
      focusVisibleStyle={{
        outlineWidth: 1,
        outlineColor: color().blue,
        outlineOffset: 1,
      }}
      style={{
        ...row,
        justifyContent: "center",
        gap: 5,
        flexShrink: 0,
        height: props.size ?? 24,
        minWidth: props.size ?? 24,
        paddingHorizontal: props.iconOnly ? 3 : 8,
        borderWidth: ghost() ? 0 : 1,
        borderColor: props.selected
          ? color().ink
          : primary()
            ? color().button
            : color().strong,
        backgroundColor: primary()
          ? color().button
          : props.selected
            ? color().selected
            : color().canvas,
        opacity: props.disabled && props.dimDisabled !== false ? 0.45 : 1,
        cursor: props.disabled ? "default" : "pointer",
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon
          name={props.icon!}
          tone={textTone()}
          size={props.iconSize ?? 12}
        />
      </If>
      <If when={!props.iconOnly}>
        <Label
          size={props.labelSize ?? 12}
          line={16}
          weight={props.labelWeight ?? (props.selected ? 600 : 400)}
          tone={textTone()}
        >
          {props.label}
        </Label>
      </If>
      <If when={props.end !== undefined}>
        <Icon
          name={props.end!}
          tone={primary() ? "buttonInk" : "muted"}
          size={10}
        />
      </If>
    </View>
  );
}

export function Field(props: {
  label: string;
  value: string;
  placeholder?: string;
  masked?: boolean;
  maxLength?: number;
  multiline?: boolean;
  style?: TextStyle;
  inputRef?: (ref: ViewRef) => void;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  onBlur?: () => void;
}) {
  const color = colors();
  const fonts = Fonts();
  const picker = pickerTarget(
    "Field",
    "apps/client/src/components/controls.tsx",
    false,
  );
  return (
    <Input
      ref={(ref) => {
        picker.ref(ref);
        props.inputRef?.(ref);
      }}
      onMouseEnter={picker.onMouseEnter}
      onMouseLeave={picker.onMouseLeave}
      accessibilityLabel={props.label}
      value={props.value}
      placeholder={props.placeholder}
      masked={props.masked}
      maxLength={props.maxLength}
      multiline={props.multiline}
      submitBehavior={
        props.onSubmit
          ? "submit"
          : props.multiline
            ? "newline"
            : "blurAndSubmit"
      }
      onChange={({ value }) => props.onChange(value)}
      onSubmit={() => props.onSubmit?.()}
      onBlur={props.onBlur}
      focusStyle={{ borderColor: color().ink }}
      style={{
        color: color().ink,
        placeholderColor: color().muted,
        backgroundColor: color().canvas,
        fontFamily: fontFamily(fonts().interface),
        fontSize: 14,
        lineHeight: 20,
        height: 32,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: color().border,
        borderRadius: 0,
        ...props.style,
      }}
    />
  );
}

export function ActionMenu(props: {
  label: string;
  value?: string;
  /** Drawn before the value, such as a status glyph. */
  leading?: JSX.Element;
  /** The colour of the value and its caret. */
  valueTone?: keyof typeof light;
  truncateValue?: boolean;
  triggerStyle?: ViewStyle;
  /** The size of the "more" glyph of a menu without a value. */
  iconSize?: number;
  children?: JSX.Element;
}) {
  const c = colors();
  const picker = pickerTarget(
    "ActionMenu",
    "apps/client/src/components/controls.tsx",
  );
  return (
    <Menu
      placement="bottom"
      align="end"
      offset={3}
      popupStyle={{
        width: 172,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      trigger={
        <View
          {...picker}
          accessibilityLabel={props.label}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            justifyContent: props.value ? "space-between" : "center",
            minWidth: 32,
            height: 30,
            paddingHorizontal: 7,
            gap: 7,
            cursor: "pointer",
            borderWidth: props.value ? 1 : 0,
            borderColor: c().strong,
            ...props.triggerStyle,
          }}
        >
          {props.leading}
          <If when={props.value}>
            <Label
              size={12}
              tone={props.valueTone}
              lines={props.truncateValue ? 1 : undefined}
              style={
                props.truncateValue || props.leading
                  ? { flex: 1, minWidth: 0 }
                  : undefined
              }
            >
              {props.value}
            </Label>
          </If>
          <Icon
            name={props.value ? "down" : "more"}
            size={
              props.value ? (props.valueTone ? 14 : 9) : (props.iconSize ?? 17)
            }
            tone={props.valueTone}
          />
        </View>
      }
    >
      {props.children}
    </Menu>
  );
}

export function ActionItem(props: {
  label: string;
  disabled?: boolean;
  checked?: boolean;
  tone?: "red";
  onSelect: () => void;
}) {
  const c = colors();
  return (
    <MenuItem
      disabled={props.disabled}
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      checked={props.checked}
      accessibilityLabel={props.label}
      style={{ ...row, minHeight: 33, paddingHorizontal: 9, gap: 6 }}
      hoverStyle={{ backgroundColor: c().selected }}
      indicatorStyle={{ width: 0 }}
      onSelect={props.onSelect}
    >
      <Label size={12} tone={props.tone} style={{ flex: 1 }}>
        {props.label}
      </Label>
      <If when={props.checked}>
        <Icon name="check" size={12} />
      </If>
    </MenuItem>
  );
}
