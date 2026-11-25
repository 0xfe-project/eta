import type { ViewStyle } from "nsh";
import type { IconName } from "../components/icons";
import { View } from "nsh";
import { colors, row } from "../components/theme";
import { icon, space, weight } from "../components/tokens";
import { createPressable } from "./behaviors";
import { Icon, Label } from "./text";

/**
 * Interactive or removable square tag/chip built on `createPressable` (keyboard focus ring,
 * hover, and optional remove button).
 */
export function Chip(props: {
  label: string;
  icon?: IconName;
  selected?: boolean;
  tone?: "neutral" | "blue" | "warning" | "red";
  accessibilityLabel?: string;
  removeLabel?: string;
  style?: ViewStyle;
  onPress?: () => void;
  onRemove?: () => void;
}) {
  const c = colors();
  const tone = () => props.tone ?? "neutral";
  const press = createPressable({
    label: () => props.accessibilityLabel ?? props.label,
    selected: () => props.selected,
    onPress: props.onPress,
  });
  const removePress = createPressable({
    label: () => props.removeLabel ?? `Remove ${props.label}`,
    focusRingKind: "inset",
    hoverBackground: () => c().border,
    onPress: props.onRemove,
  });
  const bg = () =>
    tone() === "blue"
      ? c().blueFill
      : tone() === "warning"
        ? c().warningFill
        : tone() === "red"
          ? c().redFill
          : c().selected;
  const borderColor = () =>
    props.selected
      ? c().ink
      : tone() === "blue"
        ? c().blue
        : tone() === "warning"
          ? c().warning
          : tone() === "red"
            ? c().red
            : c().strong;
  const textTone = () =>
    tone() === "blue"
      ? "blue"
      : tone() === "warning"
        ? "warningInk"
        : tone() === "red"
          ? "red"
          : "ink";
  return (
    <View
      style={{
        ...row,
        gap: space[4],
        height: space[24],
        paddingLeft: space[8],
        paddingRight: props.onRemove ? space[4] : space[8],
        borderWidth: 1,
        borderColor: borderColor(),
        backgroundColor: bg(),
        flexShrink: 0,
        ...props.style,
      }}
    >
      <If
        when={props.onPress}
        else={
          <View style={{ ...row, gap: space[4], flexShrink: 1 }}>
            <If when={props.icon !== undefined}>
              <Icon name={props.icon!} size={icon.sm} tone={textTone()} />
            </If>
            <Label
              variant="small"
              weight={props.selected ? weight.strong : weight.regular}
              tone={textTone()}
              lines={1}
            >
              {props.label}
            </Label>
          </View>
        }
      >
        <View
          role="button"
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          accessibilityState={press.accessibilityState()}
          onMouseEnter={press.onMouseEnter}
          onMouseLeave={press.onMouseLeave}
          onPress={press.press}
          focusVisibleStyle={press.focusVisibleStyle()}
          style={{ ...row, gap: space[4], flexShrink: 1, cursor: "pointer" }}
        >
          <If when={props.icon !== undefined}>
            <Icon name={props.icon!} size={icon.sm} tone={textTone()} />
          </If>
          <Label
            variant="small"
            weight={props.selected ? weight.strong : weight.regular}
            tone={textTone()}
            lines={1}
          >
            {props.label}
          </Label>
        </View>
      </If>
      <If when={props.onRemove}>
        <View
          role="button"
          accessibilityLabel={props.removeLabel ?? `Remove ${props.label}`}
          accessibilityState={removePress.accessibilityState()}
          onMouseEnter={removePress.onMouseEnter}
          onMouseLeave={removePress.onMouseLeave}
          onPress={removePress.press}
          hoverStyle={removePress.hoverStyle()}
          focusVisibleStyle={removePress.focusVisibleStyle()}
          style={{
            width: space[16],
            height: space[16],
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          <Icon name="close" size={icon.sm} tone="muted" />
        </View>
      </If>
    </View>
  );
}
