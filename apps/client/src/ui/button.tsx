import type { ViewRef, ViewStyle } from "nsh";
import type { IconName } from "../components/icons";
import type { light, TextVariant } from "../components/theme";
import { View } from "nsh";
import { pickerTarget } from "../components/element-picker";
import { shownWhile } from "../components/pending";
import { Spinner, SpinningIcon } from "../components/spinner";
import { colors, densityDefaults, row } from "../components/theme";
import { icon, opacity, space, weight } from "../components/tokens";
import { useText } from "../i18n";
import { createPressable } from "./behaviors";
import { Icon, Label } from "./text";
import { hint } from "./tooltip";

export { hint } from "./tooltip";

export function Button(props: {
  label: string;
  /** What a screen reader says when the label alone is ambiguous; `label` by default. */
  accessibilityLabel?: string;
  controlRef?: (node: ViewRef) => void;
  icon?: IconName;
  end?: IconName;
  iconOnly?: boolean;
  iconSize?: number;
  tone?: "primary" | "plain" | "ghost" | "danger";
  selected?: boolean;
  disabled?: boolean;
  /** Its action is under way: presses do nothing, nothing dims, and after `motion.reveal` a
   * spinner takes the icon's place (or sits over the label, which keeps the button's width). */
  busy?: boolean;
  /** The icon stands for the action (refresh, check again): it turns itself while `busy`, from
   * the press on, and stops on a whole turn. */
  spinIcon?: boolean;
  size?: number;
  /** The label's role; `small` by default. */
  labelVariant?: TextVariant;
  labelWeight?: number;
  /** The colour of the label and icon of a plain or ghost button, such as
   * "muted" for a filter trigger that reads as secondary. */
  labelTone?: keyof typeof light;
  dimDisabled?: boolean;
  /** The colour the label and icon take while the pointer is over the button,
   * such as "ink" for a muted ghost icon that darkens on hover. */
  hoverTone?: keyof typeof light;
  /** Said as a dark hint on hover; an icon-only button's way of naming itself. */
  tooltip?: string;
  /** Whether what the button opens is open, for a screen reader. */
  expanded?: boolean;
  /** The key that does the same, after the label (`⌘⏎` on a form's button). */
  shortcut?: string;
  /** Keyboard focus ring placement; "inset" keeps the ring inside views flush against an edge. */
  focusRingKind?: "ring" | "inset";
  style?: ViewStyle;
  onPress: () => void;
}) {
  const color = colors();
  const density = densityDefaults();
  const size = () => props.size ?? density().button;
  const picker = pickerTarget("Button", "apps/client/src/ui/button.tsx");
  const primary = () => props.tone === "primary";
  const ghost = () => props.tone === "ghost";
  const press = createPressable({
    label: () => props.accessibilityLabel ?? props.label,
    disabled: () => Boolean(props.disabled),
    busy: () => Boolean(props.busy),
    selected: () => props.selected,
    expanded: () => props.expanded,
    focusRingKind: props.focusRingKind,
    hoverBackground: () => (primary() ? color().ink : color().selected),
    onPress: () => props.onPress(),
  });
  const waiting = shownWhile(() => !!props.busy && !props.spinIcon);
  const iconSize = () => props.iconSize ?? density().buttonIcon;
  const textTone = () =>
    primary()
      ? "buttonInk"
      : props.tone === "danger"
        ? "red"
        : press.hovered() && props.hoverTone
          ? props.hoverTone
          : (props.labelTone ?? "ink");
  return (
    <View
      {...picker}
      ref={(node) => {
        picker.ref(node);
        props.controlRef?.(node);
      }}
      role="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={press.accessibilityState()}
      tooltip={hint(props.tooltip, color)}
      onMouseEnter={press.onMouseEnter}
      onMouseLeave={press.onMouseLeave}
      onPress={press.press}
      hoverStyle={press.hoverStyle()}
      focusVisibleStyle={press.focusVisibleStyle()}
      style={{
        ...row,
        justifyContent: "center",
        gap: space[4],
        flexShrink: 0,
        height: size(),
        minWidth: size(),
        paddingHorizontal: props.iconOnly ? space[4] : space[8],
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
        opacity:
          props.disabled && props.dimDisabled !== false ? opacity.disabled : 1,
        cursor: props.disabled ? "default" : "pointer",
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <If
          when={props.spinIcon}
          else={
            <If
              when={waiting()}
              else={
                <Icon name={props.icon!} tone={textTone()} size={iconSize()} />
              }
            >
              <Spinner tone={textTone()} size={iconSize()} />
            </If>
          }
        >
          <SpinningIcon
            name={props.icon!}
            running={!!props.busy}
            tone={textTone()}
            size={iconSize()}
          />
        </If>
      </If>
      <If when={!props.iconOnly}>
        <Label
          variant={props.labelVariant ?? "small"}
          weight={
            props.labelWeight ??
            (props.selected ? weight.strong : weight.regular)
          }
          tone={textTone()}
          style={{
            opacity: waiting() && props.icon === undefined ? 0 : 1,
          }}
        >
          {props.label}
        </Label>
      </If>
      <If when={waiting() && props.icon === undefined}>
        {/* No icon to take the place of: the spinner sits over the label, which keeps its
         * room so the button's width does not change. */}
        <View
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Spinner tone={textTone()} size={iconSize()} />
        </View>
      </If>
      <If when={props.shortcut}>
        <Label
          variant="caption"
          tone={textTone()}
          style={{ opacity: opacity.disabled, marginLeft: space[4] }}
        >
          {props.shortcut}
        </Label>
      </If>
      <If when={props.end !== undefined}>
        <Icon
          name={props.end!}
          tone={primary() ? "buttonInk" : "muted"}
          size={icon.sm}
        />
      </If>
    </View>
  );
}

interface NavigationButtonProps {
  onPress: () => void;
  disabled?: boolean;
  size?: number;
  iconSize?: number;
  /** Replaces the default glyph, such as an arrow on desktop task pages. */
  icon?: IconName;
  style?: ViewStyle;
}

export function BackButton(props: NavigationButtonProps) {
  const text = useText();
  return (
    <Button
      label={text("back")}
      icon={props.icon ?? "back"}
      iconOnly
      tone="ghost"
      onPress={props.onPress}
      disabled={props.disabled}
      size={props.size}
      iconSize={props.iconSize}
      style={props.style}
    />
  );
}

export function CloseButton(props: NavigationButtonProps) {
  const text = useText();
  return (
    <Button
      label={text("close")}
      icon={props.icon ?? "close"}
      iconOnly
      tone="ghost"
      onPress={props.onPress}
      disabled={props.disabled}
      size={props.size}
      iconSize={props.iconSize}
      style={props.style}
    />
  );
}
