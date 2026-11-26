import type { JSX } from "nsh";
import type { IconName } from "../icons";
import { Image, signal, Text, View } from "nsh";
import { canHover } from "../menu";
import { Icon } from "../text";
import {
  colors,
  focusRing,
  fontFamily,
  Fonts,
  monoFontFamily,
  row,
  textFaces,
} from "../theme";
import { icon, opacity, space } from "../tokens";
import { LineRoom } from "./room";

export const chipMaxWidth = 280;
/** A pasted text's preview beside its chip. */
const previewMaxWidth = 420;

/**
 * An inline block in the editor's text: a folded paste, a file, a picture. One line high, so it
 * sits in a line of text (Paper "Eta · Text", Components › Inline chips): its icon or thumbnail,
 * its name, then fainter detail. A press on its body does the block's own thing (unfold, retry,
 * open), the × takes it out (Backspace does too, and undo brings it back). The × shows while the
 * pointer is over the block where there is a pointer, and always on a touch screen.
 */
export function Chip(props: {
  label: string;
  /** Before the label, muted: "Pasted". */
  kind?: string;
  /** Before everything: a file's or a paste's glyph. */
  icon?: IconName;
  thumbnail?: string;
  /** After the label, fainter: a file's size. */
  detail?: string;
  /** A state after the label: "uploading…", "failed · retry". */
  status?: string;
  tone?: "ink" | "warning" | "red";
  /** Shown on hover (desktop): the whole reason of a failure, or the picture of an image. */
  tooltip?: string | JSX.Element;
  /** The pointer over the block's body ("zoom-in" for a picture that opens). */
  cursor?: "pointer" | "zoom-in";
  selected?: boolean;
  dim?: boolean;
  /** Determinate 0..1 inline 4px progress bar along the bottom edge without changing chip size. */
  progress?: number;
  accessibilityLabel: string;
  onPress?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  children?: JSX.Element;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const room = LineRoom();
  const hovered = signal(false);
  const text = (color: string, value: string, weight = 400, shrink = 0) => (
    <Text
      style={{
        flexShrink: shrink,
        minWidth: 0,
        fontFamily: fontFamily(fonts().interface),
        fontSize: type("small").size,
        lineHeight: type("small").line,
        fontWeight: weight,
        color,
        numberOfLines: 1,
      }}
    >
      {value}
    </Text>
  );
  const removable = () =>
    !!props.onRemove && (!canHover || hovered() || !!props.selected);
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      style={{
        ...row,
        gap: space[4],
        maxWidth:
          room() > 0
            ? Math.max(0, Math.min(chipMaxWidth, room() - space[16]))
            : chipMaxWidth,
        overflow: "hidden",
        height: type("small").line + 4,
        paddingLeft: props.thumbnail ? space[2] : space[4],
        paddingRight: removable() ? space[2] : space[8],
        marginHorizontal: 1,
        borderWidth: 1,
        borderColor: props.selected
          ? c().ink
          : props.tone === "red"
            ? c().red
            : props.tone === "warning"
              ? c().warning
              : c().strong,
        backgroundColor: props.tone === "red" ? c().redFill : c().selected,
        opacity: props.dim ? opacity.muted : 1,
      }}
    >
      <View
        role="button"
        tooltip={props.tooltip}
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        focusVisibleStyle={focusRing(c(), "inset")}
        style={{
          ...row,
          gap: space[4],
          flexShrink: 1,
          minWidth: 0,
          cursor: props.cursor ?? (props.onPress ? "pointer" : "default"),
        }}
      >
        <If when={props.thumbnail}>
          <Image
            src={props.thumbnail!}
            fadeDuration={0}
            style={{
              width: type("small").line,
              height: type("small").line,
              objectFit: "cover",
            }}
          />
        </If>
        <If when={!props.thumbnail && props.icon}>
          <Icon name={props.icon!} size={icon.sm} tone="muted" />
        </If>
        <If when={props.kind}>
          {text(c().muted, props.kind!)}
          {text(c().faint, "·")}
        </If>
        {text(c().ink, props.label, props.kind ? 600 : 400, 1)}
        <If when={props.detail}>{text(c().faint, props.detail!)}</If>
        <If when={props.status}>
          {text(
            props.tone === "red"
              ? c().red
              : props.tone === "warning"
                ? c().warningInk
                : c().muted,
            props.status!,
          )}
        </If>
      </View>
      <If when={removable()}>
        <View
          role="button"
          accessibilityLabel={props.removeLabel ?? "Remove"}
          onPress={props.onRemove}
          hoverStyle={{ backgroundColor: c().border }}
          focusVisibleStyle={focusRing(c(), "inset")}
          style={{
            width: type("small").line,
            height: type("small").line,
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          {text(c().muted, "×")}
        </View>
      </If>
      <If when={props.progress !== undefined}>
        <View
          role="progressbar"
          accessibilityLabel={props.accessibilityLabel}
          accessibilityValue={{
            min: 0,
            max: 100,
            now: Math.round(
              Math.max(0, Math.min(1, props.progress ?? 0)) * 100,
            ),
          }}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: space[4],
            backgroundColor: c().border,
            pointerEvents: "none",
          }}
        >
          <View
            style={{
              height: space[4],
              width: `${Math.round(Math.max(0, Math.min(1, props.progress ?? 0)) * 100)}%`,
              backgroundColor: c().ink,
            }}
          />
        </View>
      </If>
    </View>
  );
}

const PREVIEW_LINES = 12;

/** The first lines of a folded paste, over it on hover. */
export function PastePreview(props: { text: string }) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const lines = () => props.text.split("\n");
  return (
    <View style={{ maxWidth: previewMaxWidth, padding: space[8] }}>
      <Text
        style={{
          fontFamily: monoFontFamily(fonts()),
          fontSize: type("caption").size,
          lineHeight: type("caption").line,
          color: c().ink,
          numberOfLines: PREVIEW_LINES,
        }}
      >
        {lines().slice(0, PREVIEW_LINES).join("\n") +
          (lines().length > PREVIEW_LINES ? "\n…" : "")}
      </Text>
    </View>
  );
}

/**
 * A member mentioned in the text (`@Opus`): their name in blue on a blue fill, in a line of text
 * at the text's size. The same in the editor (where `selected` outlines it) and where the text is
 * shown.
 */
export function MentionChip(props: {
  label: string;
  variant?: "body" | "small";
  selected?: boolean;
  accessibilityLabel: string;
  /** Where the text is shown: a press opens the member. */
  onPress?: () => void;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const hovered = signal(false);
  const chip = () => (
    <Text
      accessibilityLabel={props.onPress ? undefined : props.accessibilityLabel}
      style={{
        fontFamily: fontFamily(fonts().interface),
        fontSize: type(props.variant ?? "body").size,
        color: c().blue,
        backgroundColor: c().blueFill,
        paddingHorizontal: space[2],
        borderWidth: 1,
        borderColor: props.selected || hovered() ? c().blue : c().blueFill,
      }}
    >
      {`@${props.label}`}
    </Text>
  );
  return (
    <If when={props.onPress} else={chip()}>
      <View
        role="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        onMouseEnter={() => hovered.set(true)}
        onMouseLeave={() => hovered.set(false)}
        focusVisibleStyle={focusRing(c(), "inset")}
        style={{ cursor: "pointer" }}
      >
        {chip()}
      </View>
    </If>
  );
}
