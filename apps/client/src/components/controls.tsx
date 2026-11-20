import type { InputRef, JSX, TextStyle, ViewRef, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import type { light } from "./theme";
import { platform, signal, View } from "nsh";
import { Input, Menu, MenuItem } from "nsh/base";
import { useText } from "../i18n";
import { pickerTarget } from "./element-picker";
import { Icon, Label } from "./text";
import { colors, focusRing, fontFamily, Fonts, grow, row } from "./theme";

export function Button(props: {
  label: string;
  controlRef?: (node: ViewRef) => void;
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
  /** The colour of the label and icon of a plain or ghost button, such as
   * "muted" for a filter trigger that reads as secondary. */
  labelTone?: keyof typeof light;
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
    primary()
      ? "buttonInk"
      : props.tone === "danger"
        ? "red"
        : (props.labelTone ?? "ink");
  return (
    <View
      {...picker}
      ref={(node) => {
        picker.ref(node);
        props.controlRef?.(node);
      }}
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
      focusVisibleStyle={focusRing(color())}
      style={{
        ...row,
        justifyContent: "center",
        gap: 4,
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
        // A ghost button is bare text on whatever it sits on.
        backgroundColor: primary()
          ? color().button
          : props.selected
            ? color().selected
            : ghost()
              ? undefined
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

type FieldInputProps = Pick<
  Parameters<typeof Input>[0],
  | "role"
  | "accessibilityState"
  | "accessibilityControls"
  | "accessibilityActiveDescendant"
  | "readonly"
  | "onContentSizeChange"
  | "onSelectionChange"
  | "onFocus"
  | "onCompositionChange"
  | "pasteBehavior"
  | "onPaste"
>;

export function Field(
  props: FieldInputProps & {
    label: string;
    value: string;
    placeholder?: string;
    masked?: boolean;
    maxLength?: number;
    multiline?: boolean;
    style?: TextStyle;
    inputRef?: (ref: InputRef) => void;
    onChange: (value: string) => void;
    onSubmit?: () => void;
    onBlur?: () => void;
  },
) {
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
      role={props.role}
      accessibilityState={props.accessibilityState}
      accessibilityControls={props.accessibilityControls}
      accessibilityActiveDescendant={props.accessibilityActiveDescendant}
      readonly={props.readonly}
      onContentSizeChange={props.onContentSizeChange}
      onSelectionChange={props.onSelectionChange}
      onFocus={props.onFocus}
      onCompositionChange={props.onCompositionChange}
      pasteBehavior={props.pasteBehavior}
      onPaste={props.onPaste}
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

/** Touch screens get the menu as a sheet at the bottom (NSH's `Menu`), which
 * takes the design's phone sheet: full width, a grabber and 52px rows. */
const touchSheet = !platform.desktop;

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
  /** As a sheet: a title row with a close button under the grabber. */
  sheetTitle?: string;
  /** As a popup: its width, and a lifted shadow (the design's tablet menus). */
  popupWidth?: number;
  lifted?: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  const picker = pickerTarget(
    "ActionMenu",
    "apps/client/src/components/controls.tsx",
  );
  const text = useText();
  // Open, for the pressed trigger; a titled sheet closes itself from its
  // close button.
  const open = signal(false);
  const titled = () => touchSheet && !!props.sheetTitle;
  return (
    <Menu
      placement="bottom"
      align="end"
      offset={3}
      open={titled() ? open() : undefined}
      onOpenChange={(event) => open.set(event.open)}
      popupStyle={
        touchSheet
          ? {
              width: "100%",
              paddingBottom: 8,
              borderTopWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
            }
          : {
              width: props.popupWidth ?? 172,
              paddingVertical: props.lifted ? 4 : 0,
              borderWidth: 1,
              borderColor: c().strong,
              backgroundColor: c().canvas,
              boxShadow: props.lifted
                ? [{ x: 0, y: 8, blur: 24, color: "#0000001f" }]
                : undefined,
            }
      }
      backdropStyle={{ backgroundColor: c().sheetShade }}
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
            borderWidth: props.value || open() ? 1 : 0,
            borderColor: c().strong,
            // A "more" menu stays pressed while it is open.
            backgroundColor: open() && !props.value ? c().selected : undefined,
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
      <If when={touchSheet}>
        <View style={{ alignItems: "center", paddingTop: 8, paddingBottom: 4 }}>
          <View style={{ width: 36, height: 4, backgroundColor: c().strong }} />
        </View>
        <If when={props.sheetTitle}>
          <View
            style={{ ...row, height: 44, paddingLeft: 16, paddingRight: 8 }}
          >
            <Label size={14} line={20} weight={600} lines={1} style={grow}>
              {props.sheetTitle}
            </Label>
            <Button
              label={text("close")}
              icon="close"
              iconOnly
              iconSize={16}
              tone="ghost"
              size={32}
              onPress={() => open.set(false)}
            />
          </View>
        </If>
      </If>
      {props.children}
    </Menu>
  );
}

export function ActionItem(props: {
  label: string;
  /** Muted text at the end of the row, such as a count. */
  detail?: string;
  /** The design's tablet menu row: 14px text in a 32px row. */
  roomy?: boolean;
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
      style={
        touchSheet
          ? {
              ...row,
              minHeight: 52,
              paddingHorizontal: 16,
              gap: 12,
              borderTopWidth: 1,
              borderColor: c().border,
            }
          : props.roomy
            ? { ...row, minHeight: 32, paddingHorizontal: 12, gap: 8 }
            : { ...row, minHeight: 33, paddingHorizontal: 9, gap: 6 }
      }
      hoverStyle={{ backgroundColor: c().selected }}
      indicatorStyle={{ width: 0 }}
      onSelect={props.onSelect}
    >
      <Label
        size={touchSheet || props.roomy ? 14 : 12}
        line={touchSheet ? 18 : props.roomy ? 20 : undefined}
        tone={props.tone}
        style={{ flex: 1 }}
      >
        {props.label}
      </Label>
      <If when={props.detail}>
        <Label size={12} line={16} tone="muted" style={{ flexShrink: 0 }}>
          {props.detail}
        </Label>
      </If>
      <If when={props.checked}>
        <Icon name="check" size={12} />
      </If>
    </MenuItem>
  );
}
