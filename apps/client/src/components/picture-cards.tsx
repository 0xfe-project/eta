import type { ViewedPicture } from "./picture-viewer";
import { effect, Image, signal, View } from "nsh";
import { uiText } from "../i18n";
import { Chip } from "./eta-editor/chip";
import { SkeletonBar } from "./loading-skeleton";
import { picturePreview } from "./picture-viewer";
import { Label } from "./text";
import { colors, focusRing, row } from "./theme";
import { space } from "./tokens";

// Pictures in shown text (a message, a reply, a step's screenshots), as Settings › Appearance ›
// Images in messages says: compact, a chip with the picture's name where it was put, its thumbnail
// when the pointer rests on it (desktops) and the picture on a press; expanded, cards under the
// text (Paper "Eta · Text", Display & flows).

/** A picture of shown text: what the chip and the card say, and how to ask for its bytes. */
export interface ShownPicture extends ViewedPicture {
  /** "after.png": what the chip says. */
  name: string;
  /** Asks for the bytes (once it is drawn). */
  load: () => void;
}

/** How long the pointer rests on a chip before its thumbnail shows. */
const PREVIEW_DELAY = 300;
/** The thumbnail on hover. */
const PREVIEW_SIZE = 248;
/** A card's width, its picture's height, and the gap between cards. */
const CARD_WIDTH = 180;
const CARD_PICTURE = 96;
const CARD_GAP = 8;

const openLabel = (picture: ShownPicture) =>
  uiText("openPictureNamed", { name: picture.caption });

/** Compact: the picture's name in its place; resting on it shows it, a press opens it. */
export function PictureChip(props: {
  picture: ShownPicture;
  detail?: string;
  /** What screen readers say (default: "View picture <caption>"). */
  label?: string;
  onOpen: () => void;
}) {
  effect(() => props.picture.load());
  return (
    <Chip
      label={props.picture.name}
      thumbnail={props.picture.src()}
      icon="file"
      detail={props.detail}
      cursor="zoom-in"
      tooltip={picturePreview(props.picture, PREVIEW_SIZE, PREVIEW_DELAY)}
      accessibilityLabel={props.label ?? openLabel(props.picture)}
      onPress={props.onOpen}
    />
  );
}

/** Expanded: 180-wide cards in a wrapping row, in the text's order (two to a row where two do
 * not fit, each half). */
export function PictureCards(props: {
  pictures: readonly ShownPicture[];
  onOpen: (key: string) => void;
}) {
  const c = colors();
  const room = signal(0);
  const width = () =>
    room() && room() < CARD_WIDTH * 2 + CARD_GAP
      ? Math.max(96, Math.floor((room() - CARD_GAP) / 2))
      : CARD_WIDTH;
  return (
    <View
      onLayout={({ bounds }) => room.set(bounds.size.width)}
      style={{ ...row, flexWrap: "wrap", gap: CARD_GAP, paddingTop: space[8] }}
    >
      <Each of={props.pictures} key={(picture) => picture.key}>
        {(picture) => {
          effect(() => picture().load());
          return (
            <View
              role="button"
              testID="picture-card"
              accessibilityLabel={openLabel(picture())}
              onPress={() => props.onOpen(picture().key)}
              focusVisibleStyle={focusRing(c())}
              hoverStyle={{ borderColor: c().strong }}
              style={{
                width: width(),
                flexShrink: 0,
                borderWidth: 1,
                borderColor: c().border,
                backgroundColor: c().canvas,
                cursor: "zoom-in",
              }}
            >
              <View
                style={{
                  height: CARD_PICTURE,
                  backgroundColor: c().selected,
                  overflow: "hidden",
                }}
              >
                <If
                  when={picture().src()}
                  else={
                    <SkeletonBar
                      width="100%"
                      height={CARD_PICTURE}
                      borderless
                    />
                  }
                >
                  {(src) => (
                    <Image
                      src={src()}
                      fadeDuration={0}
                      style={{
                        width: "100%",
                        height: CARD_PICTURE,
                        objectFit: "cover",
                      }}
                    />
                  )}
                </If>
              </View>
              <View
                style={{
                  borderTopWidth: 1,
                  borderColor: c().border,
                  paddingVertical: space[4],
                  paddingHorizontal: space[8],
                }}
              >
                <Label variant="caption" tone="muted" lines={1}>
                  {picture().caption}
                </Label>
              </View>
            </View>
          );
        }}
      </Each>
    </View>
  );
}
