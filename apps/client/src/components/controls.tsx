import type { InputRef, JSX, TextStyle, ViewRef, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import type { light, TextVariant } from "./theme";
import { signal, View } from "nsh";
import { Input } from "nsh/base";
import { useText } from "../i18n";
import { pickerTarget } from "./element-picker";
import {
  canHover,
  inSheet,
  MenuFrame,
  menuPresentation,
  MenuRow,
  touchRow,
  touchScreen,
} from "./menu";
import { Icon, Label } from "./text";
import {
  colors,
  focusRing,
  fontFamily,
  Fonts,
  grow,
  row,
  Screen,
  textFaces,
  textStyle,
} from "./theme";

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
  /** The label's role; `small` by default. */
  labelVariant?: TextVariant;
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
          variant={props.labelVariant ?? "small"}
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
  const type = textFaces();
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
        ...textStyle(type("body")),
        height: 32,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderWidth: 1,
        borderColor: color().border,
        borderRadius: 0,
        // A multiline field scrolls its own text, but nsh's layout still counts
        // all of that text in the content size of the `Scroll` around it, so a
        // long value made the page scroll on into blank space. Clipping the
        // field keeps its text out of that size.
        ...(props.multiline ? { overflow: "hidden" as const } : {}),
        ...props.style,
      }}
    />
  );
}

/** A menu its trigger opens: in the phone layout the design's sheet at the
 * bottom (full width, a grabber, 52pt rows), in the tablet and desktop
 * layouts a popup at the trigger (`menuPresentation`). */
export function ActionMenu(props: {
  label: string;
  value?: string;
  /** Drawn before the value, such as a status glyph. */
  leading?: JSX.Element;
  /** The colour of the value and its caret. */
  valueTone?: keyof typeof light;
  truncateValue?: boolean;
  triggerStyle?: ViewStyle;
  /** The trigger's hover, for a trigger on a row whose own hover is the default one. */
  triggerHoverStyle?: ViewStyle;
  /** The size of the "more" glyph of a menu without a value. */
  iconSize?: number;
  /** As a sheet: a title row with a close button under the grabber. */
  sheetTitle?: string;
  /** Without the caret after the value, such as the Artifacts tab's Filter button. */
  noCaret?: boolean;
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
  const layout = Screen();
  const titled = () =>
    menuPresentation(layout()) === "sheet" && !!props.sheetTitle;
  return (
    <MenuFrame
      align="end"
      open={titled() ? open() : undefined}
      onOpenChange={(next) => open.set(next)}
      popupStyle={{
        width: props.popupWidth ?? 172,
        paddingVertical: props.lifted ? 4 : 0,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        boxShadow: props.lifted
          ? [{ x: 0, y: 8, blur: 24, color: "#0000001f" }]
          : undefined,
      }}
      sheetHeader={
        <If when={props.sheetTitle}>
          <View
            style={{ ...row, height: 44, paddingLeft: 16, paddingRight: 8 }}
          >
            <Label weight={600} lines={1} style={grow}>
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
      }
      trigger={
        <View
          {...picker}
          accessibilityLabel={props.label}
          // A finger's tap area, without changing the 30pt trigger.
          hitSlop={touchScreen ? 7 : undefined}
          hoverStyle={
            canHover
              ? (props.triggerHoverStyle ?? { backgroundColor: c().selected })
              : undefined
          }
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
              variant="small"
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
          <If when={!props.noCaret}>
            <Icon
              name={props.value ? "down" : "more"}
              size={
                props.value
                  ? props.valueTone
                    ? 14
                    : 9
                  : (props.iconSize ?? 17)
              }
              tone={props.valueTone}
            />
          </If>
        </View>
      }
    >
      {props.children}
    </MenuFrame>
  );
}

export function ActionItem(props: {
  label: string;
  /** Muted text at the end of the row, such as a count. */
  detail?: string;
  /** The design's tablet menu row: `body` text in a 32px row. */
  roomy?: boolean;
  disabled?: boolean;
  checked?: boolean;
  tone?: "red";
  onSelect: () => void;
}) {
  const c = colors();
  return (
    <MenuRow
      label={props.label}
      disabled={props.disabled}
      role={props.checked === undefined ? "menuitem" : "menuitemradio"}
      checked={props.checked}
      style={
        inSheet()
          ? {
              ...row,
              minHeight: 52,
              paddingHorizontal: 16,
              gap: 12,
              borderTopWidth: 1,
              borderColor: c().border,
            }
          : props.roomy
            ? {
                ...row,
                minHeight: touchScreen ? touchRow : 32,
                paddingHorizontal: 12,
                gap: 8,
              }
            : {
                ...row,
                minHeight: touchScreen ? touchRow : 33,
                paddingHorizontal: 9,
                gap: 6,
              }
      }
      onSelect={props.onSelect}
    >
      <Label
        variant={props.roomy ? "body" : "small"}
        // One that cannot be chosen reads as such, as a native menu draws it.
        tone={props.disabled ? "muted" : props.tone}
        style={{ flex: 1 }}
      >
        {props.label}
      </Label>
      <If when={props.detail}>
        <Label variant="small" tone="muted" style={{ flexShrink: 0 }}>
          {props.detail}
        </Label>
      </If>
      <If when={props.checked}>
        <Icon name="check" size={12} />
      </If>
    </MenuRow>
  );
}
