import type { JSX, TextStyle } from "nsh";
import type { TextViewDocument, TextViewSelectionEvent } from "nsh/base";
import type { IconName } from "./icons";
import type { light, TextVariant } from "./theme";
import { Image, Text, View } from "nsh";
import { TextView } from "nsh/base";
import { iconPaths } from "./icons";
import {
  colors,
  densityDefaults,
  fontFamily,
  Fonts,
  monoFontFamily,
  textFaces,
} from "./theme";

export function Label(props: {
  children?: JSX.Element | string | number;
  /** The text's role in the type scale; the density's (`body` in regular) by default. */
  variant?: TextVariant;
  tone?: keyof typeof light;
  weight?: number;
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
        fontFamily: fontFamily(fonts().interface),
        fontSize: face().size,
        lineHeight: face().line,
        fontWeight: props.weight ?? 400,
        color: color()[props.tone ?? "ink"],
        numberOfLines: props.lines,
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
      style={{
        width: size(),
        height: size(),
        flexShrink: 0,
      }}
    />
  );
}

export function Markdown(props: {
  value?: string;
  document?: TextViewDocument;
  streaming?: boolean;
  compactHeadings?: boolean;
  /** `small` text at its tight line height with `subtitle` headings, for a
   * narrow panel. */
  dense?: boolean;
  /** The body's role: `body` by default, `small` with `dense`. Running text
   * takes the role's `prose` line height, dense text its `line`. */
  variant?: TextVariant;
  /** Compact headings (with `compactHeadings` or `dense`): role, weight and
   * the space above and below, such as `small`/600 with 6 above. */
  heading?: {
    variant?: TextVariant;
    weight?: number;
    space?: number;
    after?: number;
  };
  onSelectionChange?: (event: TextViewSelectionEvent) => void;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const code = () => ({ fontFamily: monoFontFamily(fonts()) });
  const base = props.dense
    ? { weight: 600, space: 0, after: 0 }
    : { weight: undefined, space: 16, after: 6 };
  const body = () => type(props.variant ?? (props.dense ? "small" : "body"));
  const heading = () => {
    const face = type(props.heading?.variant ?? "subtitle");
    return {
      fontSize: face.size,
      lineHeight: face.line,
      fontWeight: props.heading?.weight ?? base.weight,
      marginTop: props.heading?.space ?? base.space,
      marginBottom: props.heading?.after ?? base.after,
    };
  };
  const headings = props.compactHeadings || props.dense;
  return (
    <TextView
      markdown={props.value}
      document={props.document}
      options={{ html: false, streaming: props.streaming }}
      selectable
      onSelectionChange={props.onSelectionChange}
      links="open"
      styles={{
        root: {
          fontFamily: fontFamily(fonts().interface),
          fontSize: body().size,
          lineHeight: props.dense ? body().line : body().prose,
          color: c().ink,
        },
        paragraph: { marginTop: 0, marginBottom: 0 },
        codeBlockCode: code(),
        code: code(),
        heading1: headings ? heading() : undefined,
        heading2: headings ? heading() : undefined,
        heading3: headings ? heading() : undefined,
        link: { color: c().blue },
      }}
      codeBlockActions={[{ id: "copy" }]}
    />
  );
}

export function Caption(props: {
  text: string;
  /** The phone's 0.08em tracking. */
  phone?: boolean;
  tone?: keyof typeof light;
  style?: TextStyle;
}) {
  return (
    <Label
      variant="caption"
      tone={props.tone ?? "muted"}
      style={{
        letterSpacing: props.phone ? 0.8 : 1.2,
        textTransform: "uppercase",
        ...props.style,
      }}
    >
      {props.text}
    </Label>
  );
}

/** The 14px foreground caret at 45% in a 16px slot that ends phone list rows. */
export function RowChevron() {
  return (
    <View style={{ width: 16, alignItems: "center", flexShrink: 0 }}>
      <View style={{ opacity: 0.45 }}>
        <Icon name="right" size={14} />
      </View>
    </View>
  );
}
