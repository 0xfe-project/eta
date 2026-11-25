import type { JSX } from "nsh";
import type { IconName } from "../components/icons";
import type { Layout, TextVariant } from "../components/theme";
import { View } from "nsh";
import { pickerTarget } from "../components/element-picker";
import { colors, row } from "../components/theme";
import { control, icon, sizes, space, weight } from "../components/tokens";
import { StatusDot } from "./badge";
import { BackButton } from "./button";
import { Label } from "./text";

export function Header(props: {
  title: string;
  count?: number;
  /** The count's role (`small` by default); `body` draws it 6pt after the title. */
  countVariant?: TextVariant;
  subtitle?: string;
  subtitleTone?: "green" | "warning" | "muted";
  layout?: Layout;
  inset?: number;
  /** Right padding when the trailing control carries its own inset (a phone's 40pt button). */
  end?: number;
  /** A phone conversation's 44pt bar with a `body` title. */
  compact?: boolean;
  /** Drawn before the title, such as an avatar. */
  leading?: JSX.Element;
  dialog?: boolean;
  /** Bar fill; defaults to canvas on phones and dialogs, surface elsewhere. */
  background?: "canvas" | "surface" | "none";
  /** Bar height; defaults to 48 on phones (44 compact) and 40 elsewhere. */
  height?: number;
  /** The bottom border; on by default. */
  divider?: boolean;
  titleVariant?: TextVariant;
  titleWeight?: number;
  /** Gap between the bar's items; defaults to 4 on phones and 8 elsewhere. */
  gap?: number;
  backIcon?: IconName;
  backIconSize?: number;
  children?: JSX.Element;
  onBack?: () => void;
}) {
  const color = colors();
  const picker = pickerTarget("Header", "apps/client/src/ui/header.tsx");
  const phone = () => props.layout === "phone";
  const back = () => props.onBack !== undefined;
  // A phone top bar: 8pt insets around 40pt buttons, a `body` semibold title.
  const phoneBar = () => phone() && !props.compact && !props.dialog;
  const fallbackInset = () =>
    phone() ? (back() ? space[8] : space[16]) : space[24];
  const paddingLeft = () => {
    if (phone() && back()) return props.compact ? 0 : space[8];
    return props.inset ?? fallbackInset();
  };
  const titleVariant = (): TextVariant =>
    props.titleVariant ??
    (phone() && props.compact
      ? "body"
      : phoneBar()
        ? "body"
        : phone() || props.dialog
          ? "subtitle"
          : "body");
  return (
    <View
      {...picker}
      web={{ element: "header" }}
      style={{
        ...row,
        flexShrink: 0,
        height:
          props.height ??
          (phone()
            ? props.compact
              ? control.touch
              : space[48]
            : sizes.header),
        paddingLeft: paddingLeft(),
        paddingRight: props.end ?? props.inset ?? fallbackInset(),
        borderBottomWidth: props.divider === false ? 0 : 1,
        borderColor: color().border,
        backgroundColor:
          props.background === "none"
            ? undefined
            : props.background === "canvas"
              ? color().canvas
              : props.background === "surface"
                ? color().surface
                : phone() || props.dialog
                  ? color().canvas
                  : color().surface,
        gap: props.gap ?? (phoneBar() ? space[4] : space[8]),
        zIndex: 1,
      }}
    >
      <If when={back()}>
        <BackButton
          icon={props.backIcon}
          size={phone() ? control.touch : undefined}
          iconSize={
            props.backIconSize ??
            (phone() ? (props.compact ? icon.md : icon.lg) : undefined)
          }
          style={
            phone() && props.compact ? { marginRight: -space[8] } : undefined
          }
          onPress={() => props.onBack?.()}
        />
      </If>
      {props.leading}
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Label
          weight={
            props.titleWeight ?? (props.dialog ? weight.regular : weight.strong)
          }
          variant={titleVariant()}
          lines={1}
        >
          {props.title}
        </Label>
        <If when={props.subtitle}>
          <View style={{ ...row, gap: space[4] }}>
            <If when={props.subtitleTone}>
              <StatusDot color={color()[props.subtitleTone ?? "muted"]} />
            </If>
            <Label variant="caption" tone="muted" lines={1}>
              {props.subtitle}
            </Label>
          </View>
        </If>
      </View>
      <If when={props.count !== undefined}>
        <Label
          variant={props.countVariant ?? "small"}
          tone="muted"
          style={
            props.countVariant
              ? { marginLeft: 6 - (props.gap ?? (phoneBar() ? 4 : 8)) }
              : undefined
          }
        >
          {props.count}
        </Label>
      </If>
      <If when={props.inset === undefined}>
        <View style={{ flex: 1 }} />
      </If>
      {props.children}
      <If when={phoneBar() && back() && props.children === undefined}>
        {/* Keeps the title's lane the same as a bar with a trailing button. */}
        <View style={{ width: space[40], flexShrink: 0 }} />
      </If>
    </View>
  );
}
