import type { InputRef, JSX, TextStyle, ViewStyle } from "nsh";
import type { light } from "./theme";
import { signal, View } from "nsh";
import { Input } from "nsh/base";
import { useText } from "../i18n";
import { Button } from "../ui/button";
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
  fontFamily,
  Fonts,
  grow,
  row,
  Screen,
  textFaces,
  textStyle,
} from "./theme";
import { control, icon, shadow, space, weight } from "./tokens";

export { Button, hint } from "../ui/button";

/** A menu's width, unless its caller says. */
const menuWidth = 172;
/** A choice's row in a phone sheet, and in a menu. */
const sheetRowHeight = 52;
const checkRowHeight = 32;

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
        height: space[32],
        paddingHorizontal: space[8],
        paddingVertical: space[4],
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
  // A trigger that draws its own border (the Artifacts tab's Filter) keeps
  // it while open.
  const pressed = () =>
    open() && !props.value && props.triggerStyle?.borderWidth === undefined;
  const layout = Screen();
  const titled = () =>
    menuPresentation(layout()) === "sheet" && !!props.sheetTitle;
  return (
    <MenuFrame
      align="end"
      open={titled() ? open() : undefined}
      onOpenChange={(next) => open.set(next)}
      popupStyle={{
        width: props.popupWidth ?? menuWidth,
        paddingVertical: props.lifted ? space[4] : 0,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        boxShadow: props.lifted ? [shadow.popover] : undefined,
      }}
      sheetHeader={
        <If when={props.sheetTitle}>
          <View
            style={{
              ...row,
              height: control.touch,
              paddingLeft: space[16],
              paddingRight: space[8],
            }}
          >
            <Label weight={weight.strong} lines={1} style={grow}>
              {props.sheetTitle}
            </Label>
            <Button
              label={text("close")}
              icon="close"
              iconOnly
              iconSize={icon.md}
              tone="ghost"
              size={control.lg}
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
            minWidth: space[32],
            height: control.lg,
            paddingHorizontal: space[8],
            gap: space[8],
            cursor: "pointer",
            borderWidth: props.value ? 1 : 0,
            borderColor: c().strong,
            // A "more" menu stays pressed while it is open: its frame is an
            // outline drawn over its edge, which takes no space, so opening
            // it does not widen it and shift the row.
            ...(pressed()
              ? {
                  outlineWidth: 1,
                  outlineStyle: "solid" as const,
                  outlineColor: c().strong,
                  outlineOffset: -1,
                }
              : {}),
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
                    ? icon.md
                    : icon.sm
                  : (props.iconSize ?? icon.md)
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
              minHeight: sheetRowHeight,
              paddingHorizontal: space[16],
              gap: space[12],
              borderTopWidth: 1,
              borderColor: c().border,
            }
          : props.roomy
            ? {
                ...row,
                minHeight: touchScreen ? touchRow : space[32],
                paddingHorizontal: space[12],
                gap: space[8],
              }
            : {
                ...row,
                minHeight: touchScreen ? touchRow : checkRowHeight,
                paddingHorizontal: space[8],
                gap: space[4],
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
        <Icon name="check" size={icon.sm} />
      </If>
    </MenuRow>
  );
}
