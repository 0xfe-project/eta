import type { JSX, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import type { light, TextVariant } from "./theme";
import { View } from "nsh";
import { Icon, Label } from "./text";
import { grow } from "./theme";

/**
 * The design's empty and error state: an icon, a `body` title and a `small`
 * description up to 280 wide, 8 apart. Panes whose design draws it smaller or
 * bolder pass the roles, weights and tones they need.
 */
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
        gap: 8,
        paddingHorizontal: 24,
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon
          name={props.icon!}
          size={props.iconSize ?? 20}
          tone={props.iconTone ?? "muted"}
        />
      </If>
      <Label
        variant={props.titleVariant ?? "body"}
        weight={props.titleWeight ?? (props.description ? 500 : 400)}
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
            maxWidth: props.descriptionWidth ?? 280,
          }}
        >
          {props.description}
        </Label>
      </If>
      {props.children}
    </View>
  );
}
