import type { JSX, ViewStyle } from "nsh";
import { reduceMotion } from "nsh";
import { Popover as BasePopover } from "nsh/base";
import { menuMotion } from "../components/motion";
import { colors } from "../components/theme";
import { shadow, space } from "../components/tokens";

/**
 * Anchored popover wrapping `nsh/base` `Popover` with eta's square tokens and `menuMotion`
 * transitions (respecting `reduceMotion()`).
 */
export function Popover(props: {
  open: boolean;
  trigger: JSX.Element;
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  offset?: number;
  margin?: number;
  elevation?: "float" | "popover";
  popupStyle?: ViewStyle;
  onOpenChange: (open: boolean) => void;
  children?: JSX.Element;
}) {
  const c = colors();
  const motionAlign = () => (props.align === "end" ? "end" : "start");
  const rise = () => menuMotion(motionAlign(), reduceMotion());
  return (
    <BasePopover
      open={props.open}
      placement={props.placement ?? "bottom"}
      align={props.align ?? "start"}
      offset={props.offset ?? space[4]}
      margin={props.margin ?? space[8]}
      onOpenChange={(event) => props.onOpenChange(event.open)}
      popupStyle={{
        borderWidth: 1,
        borderColor: c().border,
        backgroundColor: c().canvas,
        boxShadow: [
          props.elevation === "popover" ? shadow.popover : shadow.float,
        ],
        ...props.popupStyle,
        ...rise().style,
      }}
      popupStartingStyle={rise().starting}
      popupEndingStyle={rise().ending}
      trigger={props.trigger}
    >
      {props.children}
    </BasePopover>
  );
}
