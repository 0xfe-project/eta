import type { AccessibilityRole, AccessibilityState, ViewStyle } from "nsh";
import { signal } from "nsh";
import { canHover } from "../../components/menu";
import { colors, focusRing } from "../../components/theme";

interface PressableOptions {
  role?: AccessibilityRole;
  label?: () => string | undefined;
  description?: () => string | undefined;
  disabled?: () => boolean;
  busy?: () => boolean;
  selected?: () => boolean | undefined;
  expanded?: () => boolean | undefined;
  checked?: () => boolean | "mixed" | undefined;
  focusRingKind?: "ring" | "inset";
  hoverBackground?: () => string | undefined;
  onPress?: () => void;
  onPressDown?: () => void;
  onPressUp?: () => void;
}

/**
 * Atomic pressable interaction behavior: unifies hover tracking (respecting pointer capability),
 * keyboard focus rings, ARIA accessibility state, and disabled/busy press suppression.
 */
export function createPressable(options: PressableOptions) {
  const c = colors();
  const hovered = signal(false);
  const disabled = () => Boolean(options.disabled?.());
  const busy = () => Boolean(options.busy?.());
  const interactive = () => !disabled() && !busy() && Boolean(options.onPress);

  const accessibilityState = (): AccessibilityState => ({
    disabled: disabled(),
    busy: busy(),
    selected: options.selected?.(),
    expanded: options.expanded?.(),
    checked: options.checked?.(),
  });

  const press = () => {
    if (interactive()) options.onPress?.();
  };
  const pressDown = () => {
    if (interactive()) options.onPressDown?.();
  };
  const pressUp = () => {
    options.onPressUp?.();
  };

  const hoverStyle = (): ViewStyle | undefined => {
    if (!canHover || disabled()) return undefined;
    const bg = options.hoverBackground
      ? options.hoverBackground()
      : c().selected;
    return bg ? { backgroundColor: bg } : undefined;
  };

  const focusVisibleStyle = () =>
    focusRing(c(), options.focusRingKind ?? "ring");
  const onMouseEnter = () => hovered.set(canHover && !disabled());
  const onMouseLeave = () => hovered.set(false);

  return {
    hovered: () => hovered(),
    disabled,
    busy,
    interactive,
    press,
    pressDown,
    pressUp,
    accessibilityState,
    hoverStyle,
    focusVisibleStyle,
    onMouseEnter,
    onMouseLeave,
    viewProps: () => ({
      role: options.role ?? ("button" as AccessibilityRole),
      accessibilityLabel: options.label?.(),
      accessibilityDescription: options.description?.(),
      accessibilityState: accessibilityState(),
      onMouseEnter,
      onMouseLeave,
      onPress: press,
      ...(options.onPressDown ? { onPressDown: pressDown } : {}),
      ...(options.onPressUp ? { onPressUp: pressUp } : {}),
      hoverStyle: hoverStyle(),
      focusVisibleStyle: focusVisibleStyle(),
    }),
  };
}
