import type { JSX, ViewStyle } from "nsh";
import type { IconName } from "../components/icons";
import type { light, TextVariant } from "../components/theme";
import { View } from "nsh";
import { grow } from "../components/theme";
import { icon, space, weight } from "../components/tokens";
import { Icon, Label } from "./text";

/**
 * The design's empty and error state: an icon, a `body` title and a `small`
 * description up to 280 wide, 8 apart. Panes whose design draws it smaller or
 * bolder pass the roles, weights and tones they need.
 */
/** How wide an empty state's description runs: `narrow` by default, `wide` in a page's main
 * column. */
export const emptyWidth = { narrow: 320, wide: 448 } as const;

export function Empty(props: {
  title: string;
  description?: string;
  icon?: IconName;
  iconSize?: number;
  iconTone?: keyof typeof light;
  titleVariant?: TextVariant;
  titleWeight?: number;
  titleTone?: keyof typeof light;
  descriptionVariant?: TextVariant;
  descriptionWidth?: number;
  children?: JSX.Element;
  style?: ViewStyle;
}) {
  return (
    <View
      style={{
        ...grow,
        justifyContent: "center",
        alignItems: "center",
        gap: space[8],
        paddingHorizontal: space[24],
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon
          name={props.icon!}
          size={props.iconSize ?? icon.lg}
          tone={props.iconTone ?? "muted"}
        />
      </If>
      <Label
        variant={props.titleVariant ?? "body"}
        weight={props.titleWeight ?? weight.regular}
        tone={props.titleTone ?? (props.description ? "ink" : "muted")}
        style={{ textAlign: "center" }}
      >
        {props.title}
      </Label>
      <If when={props.description !== undefined}>
        <Label
          tone="muted"
          variant={props.descriptionVariant ?? "small"}
          style={{
            textAlign: "center",
            maxWidth: props.descriptionWidth ?? emptyWidth.narrow,
          }}
        >
          {props.description}
        </Label>
      </If>
      {props.children}
    </View>
  );
}
