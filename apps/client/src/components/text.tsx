import type { JSX, TextStyle } from "nsh";
import type { TextViewDocument, TextViewSelectionEvent } from "nsh/base";
import type { IconName } from "./icons";
import type { light, TextVariant } from "./theme";
import { Image, Text, View } from "nsh";
import { TextView } from "nsh/base";
import { selectShown, takeShownCopies } from "./eta-editor/shown-selection";
import { iconPaths } from "./icons";
import {
  colors,
  densityDefaults,
  fontFamily,
  Fonts,
  inCompact,
  monoFontFamily,
  textFaces,
  textStyle,
} from "./theme";
import { icon, opacity, space, tracking, weight } from "./tokens";

export function Label(props: {
  children?: JSX.Element | string | number;
  /** The text's role in the type scale; the density's (`body` in regular) by default. */
  variant?: TextVariant;
  tone?: keyof typeof light;
  weight?: number;
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
        fontFamily: fontFamily(fonts().interface),
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
  /** The body's role: `body` by default, `small` with `dense` or where the
   * density is compact. Running text takes the role's `prose` line height,
   * dense text its `line`. Where compact, headings, tables and code take the
   * body's role too, so nothing in it is larger than its text. */
  variant?: TextVariant;
  /** Compact headings (with `compactHeadings`, `dense` or a compact density):
   * role, weight and the space above and below, such as `small`/600 with 6
   * above. */
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
  const compact = inCompact();
  // Its selection, for an editor that keeps the focus meanwhile (eta-editor/shown-selection).
  const self = {};
  takeShownCopies(self);
  const code = () => ({ fontFamily: monoFontFamily(fonts()) });
  const base = props.dense
    ? { weight: weight.strong, space: 0, after: 0 }
    : { weight: compact() ? weight.strong : undefined, space: 16, after: 6 };
  const variant = () =>
    props.variant ?? (props.dense || compact() ? "small" : "body");
  const body = () => type(variant());
  /** Where compact: a table's cells and a code block in the body's size, at its tight line. */
  const fit = () => (compact() ? textStyle(body()) : {});
  const heading = () => {
    const face = type(
      props.heading?.variant ?? (compact() ? variant() : "subtitle"),
    );
    return {
      fontSize: face.size,
      lineHeight: face.line,
      fontWeight: props.heading?.weight ?? base.weight,
      marginTop: props.heading?.space ?? base.space,
      marginBottom: props.heading?.after ?? base.after,
    };
  };
  const headings = () => props.compactHeadings || props.dense || compact();
  return (
    <TextView
      markdown={props.value}
      document={props.document}
      options={{ html: false, streaming: props.streaming }}
      selectable
      onSelectionChange={(event) => {
        selectShown(self, event.text, () => event.text);
        props.onSelectionChange?.(event);
      }}
      links="open"
      styles={{
        root: {
          fontFamily: fontFamily(fonts().interface),
          fontSize: body().size,
          lineHeight: props.dense ? body().line : body().prose,
          color: c().ink,
        },
        paragraph: { marginTop: 0, marginBottom: 0 },
        codeBlockCode: { ...code(), ...fit() },
        code: code(),
        heading1: headings() ? heading() : undefined,
        heading2: headings() ? heading() : undefined,
        heading3: headings() ? heading() : undefined,
        heading4: compact() ? heading() : undefined,
        heading5: compact() ? heading() : undefined,
        heading6: compact() ? heading() : undefined,
        tableGrid: {
          borderTopColor: c().border,
          borderLeftColor: c().border,
        },
        tableHead: { backgroundColor: c().selectedSoft },
        tableCell: {
          ...fit(),
          borderRightColor: c().border,
          borderBottomColor: c().border,
        },
        tableHeaderCell: {
          ...fit(),
          color: c().mutedInk,
          fontWeight: weight.strong,
          borderRightColor: c().border,
          borderBottomColor: c().border,
        },
        link: { color: c().blue },
      }}
      codeBlockActions={[{ id: "copy" }]}
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
    <View style={{ width: space[16], alignItems: "center", flexShrink: 0 }}>
      <View style={{ opacity: opacity.disabled }}>
        <Icon name="right" size={icon.md} />
      </View>
    </View>
  );
}
