import type { JSX } from "nsh";
import type { Layout } from "./theme";
import { View } from "nsh";
import { pickerTarget } from "./element-picker";
import { BackButton } from "./navigation-buttons";
import { StatusDot } from "./status-dot";
import { Label } from "./text";
import { colors, row, sizes } from "./theme";

export function Header(props: {
  title: string;
  count?: number;
  subtitle?: string;
  subtitleTone?: "green" | "amber" | "muted";
  layout?: Layout;
  inset?: number;
  /** Right padding when the trailing control carries its own inset (a phone's 40pt button). */
  end?: number;
  /** A phone conversation's 44pt bar with a 15/18 title. */
  compact?: boolean;
  /** Drawn before the title, such as an avatar. */
  leading?: JSX.Element;
  dialog?: boolean;
  children?: JSX.Element;
  onBack?: () => void;
}) {
  const color = colors();
  const picker = pickerTarget(
    "Header",
    "apps/client/src/components/header.tsx",
  );
  const phone = () => props.layout === "phone";
  return (
    <View
      {...picker}
      web={{ element: "header" }}
      style={{
        ...row,
        flexShrink: 0,
        height: phone() ? (props.compact ? 44 : 48) : sizes.header,
        paddingHorizontal: props.inset ?? (phone() ? 16 : 22),
        // A phone's 40pt back button carries its own inset.
        paddingLeft:
          phone() && props.onBack !== undefined
            ? 0
            : (props.inset ?? (phone() ? 16 : 22)),
        paddingRight: props.end ?? props.inset ?? (phone() ? 16 : 22),
        borderBottomWidth: 1,
        borderColor: color().border,
        backgroundColor:
          props.layout === "phone" || props.dialog
            ? color().canvas
            : color().surface,
        gap: 8,
        zIndex: 1,
      }}
    >
      <If when={props.onBack !== undefined}>
        <BackButton
          size={phone() ? 40 : undefined}
          iconSize={phone() ? (props.compact ? 16 : 18) : undefined}
          style={phone() ? { marginRight: -8 } : undefined}
          onPress={() => props.onBack?.()}
        />
      </If>
      {props.leading}
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Label
          weight={props.dialog ? 500 : 600}
          size={
            phone() && props.compact ? 15 : phone() || props.dialog ? 16 : 14
          }
          line={props.subtitle || (phone() && props.compact) ? 18 : 20}
          lines={1}
        >
          {props.title}
        </Label>
        <If when={props.subtitle}>
          <View style={{ ...row, gap: 6 }}>
            <If when={props.subtitleTone}>
              <StatusDot color={color()[props.subtitleTone ?? "muted"]} />
            </If>
            <Label size={11} line={15} tone="muted" lines={1}>
              {props.subtitle}
            </Label>
          </View>
        </If>
      </View>
      <If when={props.count !== undefined}>
        <Label size={12} tone="muted">
          {props.count}
        </Label>
      </If>
      <If when={props.inset === undefined}>
        <View style={{ flex: 1 }} />
      </If>
      {props.children}
    </View>
  );
}
