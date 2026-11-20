import type { JSX, TextStyle } from "nsh";
import type { IconName } from "./icons";
import type { light } from "./theme";
import { Image, Text } from "nsh";
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
  value: string;
  line?: number;
  streaming?: boolean;
  compactHeadings?: boolean;
  /** 12/16 text with 16/22 headings, for a narrow panel. */
  dense?: boolean;
}) {
  const c = colors();
  const fonts = Fonts();
  const code = () =>
    fonts().mono
      ? { fontFamily: fontFamily(fonts().mono, "monospace") }
      : undefined;
  const heading = props.dense
    ? {
        fontSize: 16,
        lineHeight: 22,
        fontWeight: 600,
        marginTop: 0,
        marginBottom: 0,
      }
    : { fontSize: 15, lineHeight: 20, marginTop: 16, marginBottom: 6 };
  const headings = props.compactHeadings || props.dense;
  return (
    <TextView
      markdown={props.value}
      options={{ html: false, streaming: props.streaming }}
      selectable
      links="open"
      styles={{
        root: {
          fontFamily: fontFamily(fonts().interface),
          fontSize: props.dense ? 12 : 14,
          lineHeight: props.line ?? (props.dense ? 16 : 24),
          color: c().ink,
        },
        paragraph: { marginTop: 0, marginBottom: 0 },
        codeBlock: code(),
        code: code(),
        heading1: headings ? heading : undefined,
        heading2: headings ? heading : undefined,
        heading3: headings ? heading : undefined,
        link: { color: c().blue },
      }}
      codeBlockActions={[{ id: "copy" }]}
    />
  );
}

export function Caption(props: { text: string; style?: TextStyle }) {
  return (
    <Label
      size={10}
      line={14}
      tone="muted"
      style={{ letterSpacing: 1.2, textTransform: "uppercase", ...props.style }}
    >
      {props.text}
    </Label>
  );
}
