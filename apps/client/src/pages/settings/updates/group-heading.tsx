import type { JSX } from "nsh";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { space, weight } from "../../../components/tokens";
import { createPressable } from "../../../ui/behaviors";

/** A group's heading row, taller on phones. */
const headingRow = 40;
const phoneHeadingRow = 44;

/**
 * With `onPress` the whole row is the button, and `children` may be a function of whether the
 * pointer is over it.
 */
export function GroupHeading(props: {
  title: string;
  phone?: boolean;
  expanded?: () => boolean;
  onPress?: () => void;
  children?: JSX.Element | ((hovered: () => boolean) => JSX.Element);
}) {
  const c = colors();
  const press = createPressable({
    label: () => props.title,
    expanded: props.expanded,
    focusRingKind: "inset",
    onPress: props.onPress,
  });
  return (
    <View
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.onPress ? props.title : undefined}
      accessibilityState={
        props.onPress ? press.accessibilityState() : undefined
      }
      onMouseEnter={props.onPress ? press.onMouseEnter : undefined}
      onMouseLeave={props.onPress ? press.onMouseLeave : undefined}
      onPress={props.onPress ? press.press : undefined}
      hoverStyle={props.onPress ? press.hoverStyle() : undefined}
      focusVisibleStyle={props.onPress ? press.focusVisibleStyle() : undefined}
      style={{
        ...row,
        justifyContent: "space-between",
        gap: space[8],
        paddingHorizontal: space[16],
        minHeight: props.phone ? phoneHeadingRow : headingRow,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: props.onPress ? "pointer" : undefined,
      }}
    >
      <Label weight={weight.strong}>{props.title}</Label>
      {typeof props.children === "function"
        ? props.children(press.hovered)
        : props.children}
    </View>
  );
}
