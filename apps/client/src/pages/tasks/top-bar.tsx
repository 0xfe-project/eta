import type { JSX } from "nsh";
import { View } from "nsh";
import { Button, colors, Label, row } from "../../components";
import { uiText } from "../../i18n";

/** Clear space left of the CaretLeft glyph inside its square: 72 of 256. */
const glyphInset = 4.5;
/** The back button's own left padding, before its glyph. */
const backPadding = 4;

/**
 * A task's top bar where it opens over its list: in the conversation panel,
 * under the 40px tab bar and as tall, and as a phone's page. "‹ Tasks" goes
 * back, the number follows on the same baseline and the bar's controls end it.
 * The glyph's drawn edge sits on `inset`, the line the title and body start on.
 */
export function TaskTopBar(props: {
  /** Left out while the task loads. */
  number?: number;
  inset: number;
  /** A finger's 32pt back button, as tall as the phone's … button; 28pt under a pointer. */
  touch?: boolean;
  background?: "canvas" | "surface";
  onBack: () => void;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        height: 40,
        gap: 8,
        flexShrink: 0,
        paddingLeft: props.inset - backPadding - glyphInset,
        paddingRight: 8,
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: c()[props.background ?? "surface"],
      }}
    >
      <Button
        label={uiText("tasks2")}
        accessibilityLabel={uiText("backToTasks")}
        icon="back"
        iconSize={16}
        tone="ghost"
        labelVariant="body"
        size={props.touch ? 32 : 28}
        style={{ gap: 2, paddingLeft: backPadding, paddingRight: 6 }}
        onPress={props.onBack}
      />
      <Label tone="muted" lines={1} style={{ flex: 1, minWidth: 0 }}>
        {props.number === undefined ? "" : `#${props.number}`}
      </Label>
      {props.children}
    </View>
  );
}
