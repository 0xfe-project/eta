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

  const hoverStyle = (): ViewStyle | undefined => {
    if (!canHover || disabled()) return undefined;
    const bg = options.hoverBackground
      ? options.hoverBackground()
      : c().selected;
    return bg ? { backgroundColor: bg } : undefined;
  };

  return {
    hovered: () => hovered(),
    disabled,
    busy,
    interactive,
    press,
    viewProps: () => ({
      role: options.role ?? ("button" as AccessibilityRole),
      accessibilityLabel: options.label?.(),
      accessibilityDescription: options.description?.(),
      accessibilityState: accessibilityState(),
      onMouseEnter: () => hovered.set(canHover && !disabled()),
      onMouseLeave: () => hovered.set(false),
      onPress: press,
      hoverStyle: hoverStyle(),
      focusVisibleStyle: focusRing(c(), options.focusRingKind ?? "ring"),
    }),
  };
}
