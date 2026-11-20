import type { JSX } from "nsh";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";

export function EditorRow(props: {
  label: string;
  hint?: JSX.Element;
  stack: boolean;
  phone?: boolean;
  width?: number;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...(props.stack ? { gap: props.phone ? 8 : 4 } : row),
        minHeight: props.stack ? undefined : 40,
        paddingHorizontal: props.stack && !props.phone ? 0 : 16,
        paddingVertical: props.stack && !props.phone ? 0 : 8,
        borderBottomWidth: props.stack && !props.phone ? 0 : 1,
        borderColor: c().border,
        columnGap: 16,
      }}
    >
      <View style={props.stack ? undefined : { flex: 1, minWidth: 0, gap: 2 }}>
        <Label
          size={props.stack && !props.phone ? 11 : 14}
          line={props.stack && !props.phone ? undefined : 20}
        >
          {props.label}
        </Label>
        <If when={!props.stack}>{props.hint}</If>
      </View>
      <View
        style={{
          width: props.stack ? "100%" : (props.width ?? 160),
          flexShrink: 0,
        }}
      >
        {props.children}
      </View>
      <If when={props.stack}>{props.hint}</If>
    </View>
  );
}
