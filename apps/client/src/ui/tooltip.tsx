import type { JSX, ViewStyle } from "nsh";
import { View } from "nsh";
import { Tooltip as BaseTooltip } from "nsh/base";
import { colors } from "../components/theme";
import { shadow, space } from "../components/tokens";
import { Label } from "./text";

/** A hover hint drawn as a small dark label (a bare string tooltip draws nothing on the web). */
export function hint(text: string | undefined, c: ReturnType<typeof colors>) {
  return text ? (
    <View
      style={{
        paddingHorizontal: space[8],
        paddingVertical: space[4],
        backgroundColor: c().ink,
      }}
    >
      <Label variant="small" tone="canvas">
        {text}
      </Label>
    </View>
  ) : undefined;
}

/**
 * Rich tooltip container wrapping `nsh/base` `Tooltip` with eta's square-corner surface tokens.
 */
export function Tooltip(props: {
  delay?: number;
  placement?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  offset?: number;
  margin?: number;
  style?: ViewStyle;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <BaseTooltip
      delay={props.delay ?? 300}
      placement={props.placement ?? "top"}
      align={props.align ?? "center"}
      offset={props.offset ?? space[4]}
      margin={props.margin ?? space[8]}
      style={{
        padding: space[8],
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        boxShadow: [shadow.popover],
        ...props.style,
      }}
    >
      {props.children}
    </BaseTooltip>
  );
}
