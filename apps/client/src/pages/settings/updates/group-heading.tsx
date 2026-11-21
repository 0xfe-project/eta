import type { JSX } from "nsh";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";

export function GroupHeading(props: {
  title: string;
  phone?: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 16,
        minHeight: props.phone ? 45 : 41,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label weight={600}>{props.title}</Label>
      {props.children}
    </View>
  );
}
