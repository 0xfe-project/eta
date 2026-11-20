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
  dialog?: boolean;
  children?: JSX.Element;
  onBack?: () => void;
}) {
  const color = colors();
  const picker = pickerTarget(
    "Header",
    "apps/client/src/components/header.tsx",
  );
  return (
    <View
      {...picker}
      web={{ element: "header" }}
      style={{
        ...row,
        flexShrink: 0,
        height: props.layout === "phone" ? 46 : sizes.header,
        paddingHorizontal: props.inset ?? (props.layout === "phone" ? 16 : 22),
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
        <BackButton onPress={() => props.onBack?.()} />
      </If>
      <View style={{ minWidth: 0, flexShrink: 1 }}>
        <Label
          weight={props.dialog ? 500 : 600}
          size={props.layout === "phone" || props.dialog ? 16 : 14}
          line={props.subtitle ? 18 : undefined}
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
