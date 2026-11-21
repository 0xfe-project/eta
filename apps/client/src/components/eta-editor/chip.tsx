import type { JSX } from "nsh";
import { Image, Text, View } from "nsh";
import { colors, fontFamily, Fonts, row, textFaces } from "../theme";

/**
 * An inline block in the editor's text: a folded paste, a file, its state. One line high, so it
 * sits in a line of text; a press on its body does the block's own thing (unfold, retry), the ×
 * takes it out (Backspace does too, and undo brings it back).
 */
export function Chip(props: {
  label: string;
  /** Shown before the label, fainter: "image", "file", "pasted". */
  kind: string;
  thumbnail?: string;
  /** A state after the label: "uploading…", "failed · retry". */
  status?: string;
  tone?: "ink" | "amber" | "red";
  selected?: boolean;
  dim?: boolean;
  accessibilityLabel: string;
  onPress?: () => void;
  onRemove?: () => void;
  removeLabel?: string;
  children?: JSX.Element;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const text = (color: string, value: string, weight = 400) => (
    <Text
      style={{
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
  return (
    <View
      style={{
        ...row,
        gap: 5,
        maxWidth: 280,
        height: type("small").line + 4,
        paddingLeft: props.thumbnail ? 2 : 6,
        paddingRight: props.onRemove ? 2 : 6,
        marginHorizontal: 1,
        borderWidth: 1,
        borderColor: props.selected
          ? c().ink
          : props.tone === "red"
            ? c().red
            : props.tone === "amber"
              ? c().warning
              : c().strong,
        backgroundColor: props.tone === "red" ? c().redFill : c().selected,
        opacity: props.dim ? 0.6 : 1,
      }}
    >
      <View
        role="button"
        accessibilityLabel={props.accessibilityLabel}
        onPress={props.onPress}
        style={{
          ...row,
          gap: 5,
          flexShrink: 1,
          cursor: props.onPress ? "pointer" : "default",
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
        {text(c().muted, props.kind)}
        {text(c().faint, "·")}
        {text(c().ink, props.label, 500)}
        <If when={props.status}>
          {text(
            props.tone === "red"
              ? c().red
              : props.tone === "amber"
                ? c().warningInk
                : c().muted,
            props.status!,
          )}
        </If>
      </View>
      <If when={props.onRemove}>
        <View
          role="button"
          accessibilityLabel={props.removeLabel ?? "Remove"}
          onPress={props.onRemove}
          hoverStyle={{ backgroundColor: c().border }}
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
    </View>
  );
}
