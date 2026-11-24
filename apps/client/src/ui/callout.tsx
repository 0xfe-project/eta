import type { JSX, ViewStyle } from "nsh";
import type { IconName } from "../components/icons";
import type { light } from "../components/theme";
import { View } from "nsh";
import { colors, row } from "../components/theme";
import { icon, space, weight } from "../components/tokens";
import { Icon, Label } from "./text";

type CalloutTone = "info" | "success" | "warning" | "danger" | "neutral";

const toneStyles: Record<
  CalloutTone,
  {
    fill: keyof typeof light;
    border: keyof typeof light;
    text: keyof typeof light;
    icon: keyof typeof light;
  }
> = {
  info: { fill: "blueFill", border: "blue", text: "ink", icon: "blue" },
  success: { fill: "greenFill", border: "green", text: "ink", icon: "green" },
  warning: {
    fill: "warningFill",
    border: "warningLine",
    text: "warningInk",
    icon: "warning",
  },
  danger: { fill: "redFill", border: "red", text: "red", icon: "red" },
  neutral: {
    fill: "surface",
    border: "border",
    text: "ink",
    icon: "mutedInk",
  },
};

export function Callout(props: {
  tone?: CalloutTone;
  title: string;
  description?: string;
  icon?: IconName;
  /** Announce immediately via `role="alert"` (default true for danger/warning). */
  alert?: boolean;
  /** Compact inline layout without fill/border (e.g. a form error block). */
  inline?: boolean;
  actions?: JSX.Element;
  style?: ViewStyle;
}) {
  const c = colors();
  const tone = () => props.tone ?? "neutral";
  const palette = () => toneStyles[tone()];
  const isAlert = () =>
    props.alert ?? (tone() === "danger" || tone() === "warning");
  return (
    <View
      role={isAlert() ? "alert" : undefined}
      accessibilityLiveRegion={isAlert() ? "polite" : undefined}
      style={{
        ...row,
        alignItems: "flex-start",
        gap: space[8],
        paddingHorizontal: props.inline ? space[16] : space[12],
        paddingVertical: props.inline ? space[16] : space[8],
        backgroundColor: props.inline ? undefined : c()[palette().fill],
        borderWidth: props.inline ? 0 : 1,
        borderColor: c()[palette().border],
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <View style={{ height: space[16], justifyContent: "center" }}>
          <Icon name={props.icon!} size={icon.sm} tone={palette().icon} />
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
        <Label
          variant={props.inline ? "body" : "small"}
          weight={props.description ? weight.strong : weight.regular}
          tone={palette().text}
        >
          {props.title}
        </Label>
        <If when={props.description}>
          <Label variant="small" tone="muted">
            {props.description}
          </Label>
        </If>
      </View>
      {props.actions}
    </View>
  );
}

/**
 * A compact single-line warning callout with the design's 12px Warning mark before it:
 * solid in list rows, or outline where the design draws one.
 */
export function WarningLine(props: { text: string; outline?: boolean }) {
  return (
    <View
      style={{
        ...row,
        alignSelf: "stretch",
        gap: space[4],
        alignItems: "flex-start",
      }}
    >
      <View style={{ height: space[16], justifyContent: "center" }}>
        <Icon
          name={props.outline ? "warning" : "warningFill"}
          size={icon.sm}
          tone="warning"
        />
      </View>
      <Label variant="small" tone="warningInk" style={{ flex: 1, minWidth: 0 }}>
        {props.text}
      </Label>
    </View>
  );
}
