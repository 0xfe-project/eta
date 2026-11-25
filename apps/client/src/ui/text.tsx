import type { JSX, TextStyle } from "nsh";
import type { IconName } from "../components/icons";
import type { light, TextVariant } from "../components/theme";
import { Image, Text, View } from "nsh";
import { iconPaths } from "../components/icons";
import {
  colors,
  densityDefaults,
  fontFamily,
  Fonts,
  monoFontFamily,
  textFaces,
} from "../components/theme";
import { icon, opacity, space, tracking, weight } from "../components/tokens";

export function Label(props: {
  children?: JSX.Element | string | number;
  /** The text's role in the type scale; the density's (`body` in regular) by default. */
  variant?: TextVariant;
  tone?: keyof typeof light;
  weight?: number;
  /** Use the client's monospace font stack (codes, shortcuts, paths). */
  mono?: boolean;
  /** Letter spacing, in em of the role's size: `caps` with uppercase, `tight` for display text. */
  tracking?: keyof typeof tracking;
  lines?: number;
  style?: TextStyle;
}) {
  const color = colors();
  const fonts = Fonts();
  const type = textFaces();
  const density = densityDefaults();
  const face = () => type(props.variant ?? density().text);
  return (
    <Text
      style={{
        fontFamily: props.mono
          ? monoFontFamily(fonts())
          : fontFamily(fonts().interface),
        fontSize: face().size,
        lineHeight: face().line,
        fontWeight: props.weight ?? weight.regular,
        color: color()[props.tone ?? "ink"],
        numberOfLines: props.lines,
        ...(props.tracking
          ? { letterSpacing: tracking[props.tracking] * face().size }
          : {}),
        ...props.style,
      }}
    >
      {props.children}
    </Text>
  );
}

export function Icon(props: {
  name: IconName;
  size?: number;
  tone?: keyof typeof light;
  /** When omitted, the icon is decorative and hidden from assistive technologies. */
  accessibilityLabel?: string;
}) {
  const color = colors();
  const density = densityDefaults();
  const size = () => props.size ?? density().icon;
  const src = () =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path fill="${
        color()[props.tone ?? "ink"]
      }" d="${iconPaths[props.name]}"/></svg>`,
    )}`;
  return (
    <Image
      src={src()}
      fadeDuration={0}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityElementsHidden={!props.accessibilityLabel}
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
      }}
    />
  );
}

export function Caption(props: {
  text: string;
  tone?: keyof typeof light;
  style?: TextStyle;
}) {
  return (
    <Label
      variant="caption"
      tone={props.tone ?? "muted"}
      tracking="caps"
      style={{ textTransform: "uppercase", ...props.style }}
    >
      {props.text}
    </Label>
  );
}

/** The 14px foreground caret at 45% in a 16px slot that ends phone list rows. */
export function RowChevron() {
  return (
    <View
      accessibilityElementsHidden
      style={{ width: space[16], alignItems: "center", flexShrink: 0 }}
    >
      <View style={{ opacity: opacity.disabled }}>
        <Icon name="right" size={icon.md} />
      </View>
    </View>
  );
}
