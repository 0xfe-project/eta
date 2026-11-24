import type { JSX } from "nsh";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { space, weight } from "../../../components/tokens";

/** A group's heading row, taller on phones. */
const headingRow = 40;
const phoneHeadingRow = 44;

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
        gap: space[8],
        paddingHorizontal: space[16],
        minHeight: props.phone ? phoneHeadingRow : headingRow,
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
    >
      <Label weight={weight.strong}>{props.title}</Label>
      {props.children}
    </View>
  );
}
