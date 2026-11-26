import type { JSX, ViewStyle } from "nsh";
import type { light } from "../components/theme";
import { signal, View } from "nsh";
import { pickerTarget } from "../components/element-picker";
import {
  canHover,
  inSheet,
  MenuFrame,
  menuPresentation,
  MenuRow,
  touchRow,
  touchScreen,
} from "../components/menu";
import { colors, focusRing, grow, row, Screen } from "../components/theme";
import {
  control,
  icon,
  opacity,
  shadow,
  space,
  weight,
} from "../components/tokens";
import { useText } from "../i18n";
import { Button } from "./button";
import { Icon, Label } from "./text";

/** A menu's width, unless its caller says. */
const menuWidth = 172;
/** A choice's row in a phone sheet, and in a menu. */
const sheetRowHeight = 52;
const checkRowHeight = 32;
/** A phone action menu stays at least half the screen high. */
const menuSheetMinHeight = "50%";

/**
 * Adaptive action menu: phone bottom sheet (full width, grabber, 52pt rows) or desktop/tablet
 * anchored popup, with keyboard focus ring on its trigger.
 */
export function ActionMenu(props: {
  label: string;
  value?: string | (() => string);
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
  disabled?: boolean;
  /** What it says while it has no options: pass it only then. */
  empty?: string;
  children?: JSX.Element;
}) {
  const c = colors();
  const picker = pickerTarget("ActionMenu", "apps/client/src/ui/menu.tsx");
  const text = useText();
  const open = signal(false);
  const value = () =>
    typeof props.value === "function" ? props.value() : props.value;
  const pressed = () =>
    open() && !value() && props.triggerStyle?.borderWidth === undefined;
  const layout = Screen();
  const titled = () =>
    menuPresentation(layout()) === "sheet" && !!props.sheetTitle;
  return (
    <MenuFrame
      align="end"
      disabled={props.disabled}
      empty={props.empty}
      open={titled() ? open() : undefined}
      onOpenChange={(next) => open.set(next)}
      sheetStyle={{ minHeight: menuSheetMinHeight }}
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
          accessibilityState={{ disabled: props.disabled }}
          hitSlop={touchScreen ? 7 : undefined}
          hoverStyle={
            canHover
              ? (props.triggerHoverStyle ?? { backgroundColor: c().selected })
              : undefined
          }
          focusVisibleStyle={focusRing(c())}
          style={{
            ...row,
            justifyContent: value() ? "space-between" : "center",
            minWidth: space[32],
            height: control.lg,
            paddingHorizontal: space[8],
            gap: space[8],
            cursor: props.disabled ? "default" : "pointer",
            opacity: props.disabled ? opacity.disabled : undefined,
            borderWidth: value() ? 1 : 0,
            borderColor: c().strong,
            ...(pressed()
              ? {
                  outlineWidth: 1,
                  outlineStyle: "solid" as const,
                  outlineColor: c().strong,
                  outlineOffset: -1,
                }
              : {}),
            backgroundColor:
              !props.disabled && open() && !value() ? c().selected : undefined,
            ...props.triggerStyle,
          }}
        >
          {props.leading}
          <If when={value()}>
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
              {value()}
            </Label>
          </If>
          <If when={!props.noCaret}>
            <Icon
              name={value() ? "down" : "more"}
              size={
                value()
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
  checked?: boolean | (() => boolean);
  tone?: "red";
  onSelect: () => void;
}) {
  const c = colors();
  const checked = () =>
    typeof props.checked === "function" ? props.checked() : props.checked;
  return (
    <MenuRow
      label={props.label}
      disabled={props.disabled}
      role={checked() === undefined ? "menuitem" : "menuitemradio"}
      checked={checked()}
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
      <If when={checked()}>
        <Icon name="check" size={icon.sm} />
      </If>
    </MenuRow>
  );
}
