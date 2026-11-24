import type { TextViewDocument, TextViewSelectionEvent } from "nsh/base";
import type { TextVariant } from "./theme";
import { TextView } from "nsh/base";
import { selectShown, takeShownCopies } from "./eta-editor/shown-selection";
import {
  colors,
  fontFamily,
  Fonts,
  inCompact,
  monoFontFamily,
  textFaces,
  textStyle,
} from "./theme";
import { weight } from "./tokens";

export { Caption, Icon, Label, RowChevron } from "../ui/text";

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
