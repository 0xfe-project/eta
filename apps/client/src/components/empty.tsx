import type { JSX, ViewStyle } from "nsh";
import type { IconName } from "./icons";
import { View } from "nsh";
import { Icon, Label } from "./text";
import { grow } from "./theme";

export function Empty(props: {
  title: string;
  description?: string;
  icon?: IconName;
  iconSize?: number;
  children?: JSX.Element;
  style?: ViewStyle;
}) {
  return (
    <View
      style={{
        ...grow,
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 24,
        ...props.style,
      }}
    >
      <If when={props.icon !== undefined}>
        <Icon name={props.icon!} size={props.iconSize ?? 20} tone="muted" />
      </If>
      <Label
        weight={props.description ? 500 : 400}
        tone={props.description ? "ink" : "muted"}
        style={{ textAlign: "center" }}
      >
        {props.title}
      </Label>
      <If when={props.description !== undefined}>
        <Label
          tone="muted"
          size={12}
          style={{ textAlign: "center", maxWidth: 300 }}
        >
          {props.description}
        </Label>
      </If>
      {props.children}
    </View>
  );
}
