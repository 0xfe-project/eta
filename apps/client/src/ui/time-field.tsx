import type { ViewStyle } from "nsh";
import { View } from "nsh";
import { TimeField as BaseTimeField } from "nsh/base";
import {
  colors,
  fontFamily,
  Fonts,
  row,
  textFaces,
  textStyle,
} from "../components/theme";
import { control, icon, space } from "../components/tokens";
import { Icon, Label } from "./text";

export function TimeField(props: {
  label: string;
  value: string;
  hourCycle?: "h12" | "h23";
  height?: number;
  iconSize?: number;
  paddingHorizontal?: number;
  style?: ViewStyle;
  onChange: (value: string) => void;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  return (
    <View
      style={{
        ...row,
        height: props.height ?? control.lg,
        gap: space[8],
        paddingHorizontal: props.paddingHorizontal ?? space[8],
        justifyContent: "space-between",
        borderWidth: 1,
        borderColor: c().border,
        ...props.style,
      }}
    >
      <BaseTimeField
        accessibilityLabel={props.label}
        value={props.value}
        hourCycle={props.hourCycle ?? "h23"}
        onChange={({ value }) => props.onChange(value)}
        style={{ ...row }}
        renderSegment={(entry) => (
          <Label
            variant="small"
            style={{ marginLeft: entry.segment === "period" ? space[4] : 0 }}
          >
            {entry.label}
          </Label>
        )}
        separatorStyle={{
          fontFamily: fontFamily(fonts().interface),
          ...textStyle(type("small")),
          color: c().ink,
        }}
      />
      <Icon name="routines" size={props.iconSize ?? icon.sm} />
    </View>
  );
}
