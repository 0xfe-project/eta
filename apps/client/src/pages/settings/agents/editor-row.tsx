import type { JSX, ViewRef } from "nsh";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { space } from "../../../components/tokens";

/** A field beside its label. */
const fieldWidth = 160;

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
        ...(props.stack ? { gap: props.phone ? space[8] : space[4] } : row),
        minHeight: props.stack ? undefined : space[40],
        paddingHorizontal: props.stack && !props.phone ? 0 : space[16],
        paddingVertical: props.stack && !props.phone ? 0 : space[8],
        borderBottomWidth: props.stack && !props.phone ? 0 : 1,
        borderColor: c().border,
        columnGap: space[16],
      }}
    >
      <View
        style={
          props.stack ? undefined : { flex: 1, minWidth: 0, gap: space[2] }
        }
      >
        <Label variant={props.stack ? "caption" : "body"}>{props.label}</Label>
        <If when={!props.stack}>{props.hint}</If>
      </View>
      <View
        style={{
          width: props.stack ? "100%" : (props.width ?? fieldWidth),
          flexShrink: 0,
        }}
      >
        {props.children}
      </View>
      <If when={props.stack}>{props.hint}</If>
    </View>
  );
}

/** The creator opens each step with its first field focused, as the design draws it. */
export function focusOnOpen(node: ViewRef) {
  setTimeout(() => node.focus(), 50);
}
