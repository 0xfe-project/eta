import type { JSX, ViewStyle } from "nsh";
import type { IconName } from "../components/icons";
import type { light } from "../components/theme";
import { View } from "nsh";
import { colors, row } from "../components/theme";
import { icon, space } from "../components/tokens";
import { Icon, Label } from "./text";

/** A dot or square mark beside a name or a row: a state, an unread count's place. */
export const dotSize = 8;

export function StatusDot(props: {
  color: string;
  size?: number;
  opacity?: number;
  testID?: string;
}) {
  return (
    <View
      testID={props.testID}
      accessibilityElementsHidden
      style={{
        width: props.size ?? dotSize,
        height: props.size ?? dotSize,
        backgroundColor: props.color,
        opacity: props.opacity ?? 1,
        flexShrink: 0,
      }}
    />
  );
}

type BadgeTone = "neutral" | "blue" | "green" | "warning" | "red";

const softToneMap: Record<
  BadgeTone,
  {
    fill: keyof typeof light;
    text: keyof typeof light;
    border: keyof typeof light;
  }
> = {
  neutral: { fill: "selected", text: "mutedInk", border: "strong" },
  blue: { fill: "blueFill", text: "blue", border: "blue" },
  green: { fill: "greenFill", text: "green", border: "green" },
  warning: { fill: "warningFill", text: "warningInk", border: "warning" },
  red: { fill: "redFill", text: "red", border: "red" },
};

export function Badge(props: {
  label: string;
  tone?: BadgeTone;
  /** Override semantic text color when domain status maps to a specific palette key. */
  textTone?: keyof typeof light;
  variant?: "soft" | "outline";
  size?: "caption" | "small";
  icon?: IconName;
  leading?: JSX.Element;
  style?: ViewStyle;
}) {
  const c = colors();
  const palette = () => softToneMap[props.tone ?? "neutral"];
  const outline = () => props.variant === "outline";
  const textTone = () => props.textTone ?? palette().text;
  const hasLeading = () =>
    props.icon !== undefined || props.leading !== undefined;
  return (
    <View
      style={{
        ...row,
        paddingVertical: 1,
        paddingLeft: hasLeading() ? space[4] : space[8],
        paddingRight: space[8],
        gap: space[4],
        flexShrink: 0,
        backgroundColor: outline() ? c().canvas : c()[palette().fill],
        borderWidth: outline() ? 1 : 0,
        borderColor: c()[palette().border],
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon name={props.icon!} size={icon.sm} tone={textTone()} />
      </If>
      {props.leading}
      <Label
        variant={props.size ?? "small"}
        lines={1}
        tone={textTone()}
        style={{ flexShrink: 1, minWidth: 0 }}
      >
        {props.label}
      </Label>
    </View>
  );
}
