import type { JSX, TextStyle } from "nsh";
import type { TextViewDocument } from "nsh/base";
import type { IconName } from "./icons";
import type { light } from "./theme";
import { Image, Text, View } from "nsh";
import { TextView } from "nsh/base";
import { iconPaths } from "./icons";
import { colors, fontFamily, Fonts } from "./theme";

export function Label(props: {
  children?: JSX.Element | string | number;
  size?: number;
  line?: number;
  tone?: keyof typeof light;
  weight?: number;
  lines?: number;
  style?: TextStyle;
}) {
  const color = colors();
  const fonts = Fonts();
  return (
    <Text
      style={{
        fontFamily: fontFamily(fonts().interface),
        fontSize: props.size ?? 14,
        lineHeight: props.line ?? (props.size ?? 14) + 6,
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
        width: props.size ?? 14,
        height: props.size ?? 14,
        flexShrink: 0,
      }}
    />
  );
}

export function Markdown(props: {
  value?: string;
  document?: TextViewDocument;
  line?: number;
  streaming?: boolean;
  compactHeadings?: boolean;
  /** 12/16 text with 16/22 headings, for a narrow panel. */
  dense?: boolean;
  /** The body size, such as 12 (with `line` 16) in a task's description. */
  size?: number;
  /** Compact headings (with `compactHeadings` or `dense`): size, line,
   * weight and the space above and below, such as 13/16/600 with 6 above. */
  heading?: {
    size?: number;
    line?: number;
    weight?: number;
    space?: number;
    after?: number;
  };
}) {
  const c = colors();
  const fonts = Fonts();
  const code = () =>
    fonts().mono
      ? { fontFamily: fontFamily(fonts().mono, "monospace") }
      : undefined;
  const base = props.dense
    ? { size: 16, line: 22, weight: 600, space: 0, after: 0 }
    : { size: 15, line: 20, weight: undefined, space: 16, after: 6 };
  const heading = () => ({
    fontSize: props.heading?.size ?? base.size,
    lineHeight: props.heading?.line ?? base.line,
    fontWeight: props.heading?.weight ?? base.weight,
    marginTop: props.heading?.space ?? base.space,
    marginBottom: props.heading?.after ?? base.after,
  });
  const headings = props.compactHeadings || props.dense;
  return (
    <TextView
      markdown={props.value}
      document={props.document}
      options={{ html: false, streaming: props.streaming }}
      selectable
      links="open"
      styles={{
        root: {
          fontFamily: fontFamily(fonts().interface),
          fontSize: props.size ?? (props.dense ? 12 : 14),
          lineHeight: props.line ?? (props.dense ? 16 : 24),
          color: c().ink,
        },
        paragraph: { marginTop: 0, marginBottom: 0 },
        codeBlock: code(),
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
  /** The phone's tighter 10/12 caption with 0.08em tracking. */
  phone?: boolean;
  tone?: keyof typeof light;
  style?: TextStyle;
}) {
  return (
    <Label
      size={10}
      line={props.phone ? 12 : 14}
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
