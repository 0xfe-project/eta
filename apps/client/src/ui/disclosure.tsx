import type { JSX, ViewRef, ViewStyle } from "nsh";
import { View } from "nsh";
import { row } from "../components/theme";
import { icon, space } from "../components/tokens";
import {
  createDisclosure,
  createPressable,
  definePrimitive,
} from "./behaviors";
import { Icon, Label } from "./text";

/**
 * Headless + styled Disclosure primitive built with `definePrimitive` + `createDisclosure` +
 * `createPressable` (keyboard focus ring, hover, `expanded` ARIA state, optional `foldNext`).
 */
export const Disclosure = definePrimitive({
  name: "Disclosure",
  setup: (options: {
    open?: () => boolean;
    defaultOpen?: boolean;
    animated?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) =>
    createDisclosure({
      open: options.open,
      defaultOpen: options.defaultOpen,
      animated: options.animated,
      onOpenChange: options.onOpenChange,
    }),
  parts: (useState) => ({
    Trigger: (props: {
      label: string;
      accessibilityLabel?: string;
      trailing?: JSX.Element;
      controlRef?: (node: ViewRef) => void;
      style?: ViewStyle;
      children?: JSX.Element;
    }) => {
      const state = useState();
      const press = createPressable({
        label: () => props.accessibilityLabel ?? props.label,
        expanded: state.open,
        focusRingKind: "inset",
        onPress: state.toggle,
      });
      return (
        <View
          ref={props.controlRef}
          role="button"
          accessibilityLabel={props.accessibilityLabel ?? props.label}
          accessibilityState={press.accessibilityState()}
          onMouseEnter={press.onMouseEnter}
          onMouseLeave={press.onMouseLeave}
          onPress={press.press}
          hoverStyle={press.hoverStyle()}
          focusVisibleStyle={press.focusVisibleStyle()}
          style={{ ...row, gap: space[4], cursor: "pointer", ...props.style }}
        >
          <Icon
            name={state.open() ? "down" : "right"}
            size={icon.sm}
            tone={state.open() ? "muted" : "faint"}
          />
          <If
            when={props.children}
            else={
              <Label variant="small" tone="muted">
                {props.label}
              </Label>
            }
          >
            {props.children}
          </If>
          {props.trailing}
        </View>
      );
    },
    Content: (props: { style?: ViewStyle; children?: JSX.Element }) => {
      const state = useState();
      return (
        <If when={state.open()}>
          <View style={props.style}>{props.children}</View>
        </If>
      );
    },
  }),
});
