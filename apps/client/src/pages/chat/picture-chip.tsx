import type { ViewStyle } from "nsh";
import type { TextVariant } from "../../components";
import type { useAttachmentPictures } from "../../services/pictures";
import { effect, signal, View } from "nsh";
import { colors, focusRing, Label } from "../../components";
import { picturePreview } from "../../components/picture-viewer";
import { uiText } from "../../i18n";

type AttachmentPicture = ReturnType<ReturnType<typeof useAttachmentPictures>>;

/**
 * An attached picture's name and size: the mouse resting on it or the keyboard focusing it shows
 * the picture beside it (desktops), a press or a tap opens it over the window (`onOpen`). The
 * picture is asked for as the chip is made.
 */
export function PictureChip(props: {
  picture: AttachmentPicture;
  name: string;
  size: string;
  /** The text the chip shows: "[name · size]" in a message, the name alone in the composer. */
  text: string;
  variant?: TextVariant;
  tone?: "ink" | "muted";
  style?: ViewStyle;
  onOpen: () => void;
}) {
  const c = colors();
  const hovered = signal(false);
  effect(() => props.picture.load());
  return (
    <View
      role="button"
      accessibilityLabel={uiText("openPicture", {
        name: props.name,
        size: props.size,
      })}
      tooltip={picturePreview(props.picture)}
      onPress={props.onOpen}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      focusVisibleStyle={focusRing(c())}
      style={{ cursor: "zoom-in", minWidth: 0, ...props.style }}
    >
      <Label
        variant={props.variant}
        tone={props.tone}
        lines={1}
        style={{ textDecorationLine: hovered() ? "underline" : "none" }}
      >
        {props.text}
      </Label>
    </View>
  );
}
