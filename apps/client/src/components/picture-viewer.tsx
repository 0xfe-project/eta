import type { JSX } from "nsh";
import { Image, keymap, Scroll, signal, View, windowSize } from "nsh";
import { uiText } from "../i18n";
import { NativeDialog, Tooltip } from "../ui";
import { Button } from "./controls";
import { CloseButton } from "./navigation-buttons";
import { screenInsets } from "./safe-area";
import { Label } from "./text";
import { colors, fill, Fonts, monoFontFamily, row } from "./theme";
import { space } from "./tokens";

/** The viewer's bottom bar. */
const barHeight = 32;

/** One picture as the preview and the lightbox show it: where it is, and its caption. */
export interface ViewedPicture {
  key: string;
  /** "image.png · 24.6 KB", or "PNG · 84 KB" for a picture with no name. */
  caption: string;
  /** What `<Image>` shows, once it has it. */
  src: () => string | undefined;
  failed: () => boolean;
}

interface PixelSize {
  width: number;
  height: number;
}

// A picture's own size, learnt from the first `<Image>` that loaded it, so the preview and the
// lightbox size it at once the next time.
const sizes = new Map<string, PixelSize>();

/** `size` scaled down, never up, to fit in `width` × `height`. */
function fit(size: PixelSize, width: number, height: number): PixelSize {
  const scale = Math.min(
    1,
    Math.max(0, width) / size.width,
    Math.max(0, height) / size.height,
  );
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

/**
 * The picture, at its own size within `maxWidth` × `maxHeight` (or at its own size, `actual`);
 * until it is here, its caption (or that it failed) in a box of the size a picture would take.
 */
function PictureImage(props: {
  picture: ViewedPicture;
  maxWidth: number;
  maxHeight: number;
  actual?: boolean;
}) {
  const size = signal(sizes.get(props.picture.key));
  const box = () => {
    const known = size();
    if (!known)
      return {
        width: Math.min(240, props.maxWidth),
        height: Math.min(160, props.maxHeight),
      };
    return props.actual ? known : fit(known, props.maxWidth, props.maxHeight);
  };
  return (
    <If
      when={props.picture.src()}
      else={
        <View
          style={{
            minWidth: Math.min(160, props.maxWidth),
            minHeight: Math.min(96, props.maxHeight),
            padding: space[8],
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Label variant="caption" tone="faint">
            {props.picture.failed()
              ? uiText("pictureFailed")
              : props.picture.caption}
          </Label>
        </View>
      }
    >
      {(src) => (
        <Image
          src={src()}
          fadeDuration={0}
          accessibilityLabel={props.picture.caption}
          style={{ ...box(), objectFit: "contain" }}
          onLoad={(event) => {
            if (event.size.width <= 0 || event.size.height <= 0) return;
            sizes.set(props.picture.key, event.size);
            size.set(event.size);
          }}
        />
      )}
    </If>
  );
}

function PictureCaption(props: { children: string }) {
  const fonts = Fonts();
  return (
    <Label
      variant="caption"
      tone="muted"
      lines={1}
      style={{
        fontFamily: monoFontFamily(fonts()),
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      {props.children}
    </Label>
  );
}

/**
 * The `tooltip` of a picture's chip or thumbnail: the picture beside it, at most
 * `min(90vw, 720px)` × `70vh`, with its caption under it. NSH shows it once the mouse has rested
 * on the trigger for 200ms or the keyboard has focused it, and hides it as either leaves; never
 * on a touch screen, where a tap opens the lightbox instead. It takes no pointer, so it cannot
 * hold itself open. `size` caps it (an editor's chip previews at 248).
 */
export function picturePreview(
  picture: ViewedPicture,
  size?: number,
  /** How long the pointer rests before it shows (shown text waits 300ms). */
  delay = 200,
): JSX.Element {
  const outer = () => Math.min(windowSize().width * 0.9, size ?? 720);
  const width = () => outer() - 10;
  const height = () => (size ? size * 0.75 : windowSize().height * 0.7);
  return (
    <Tooltip
      delay={delay}
      placement="top"
      align="start"
      offset={6}
      margin={8}
      style={{
        gap: space[4],
        padding: space[4],
        maxWidth: outer(),
      }}
    >
      <PictureImage picture={picture} maxWidth={width()} maxHeight={height()} />
      <PictureCaption>{picture.caption}</PictureCaption>
    </Tooltip>
  );
}

/**
 * Pictures over the whole window: the one at `index` fitted to the screen, at its own size once
 * pressed (pressed again, fitted again); the arrow keys, a swipe or the bar's buttons walk through
 * the rest; Escape, the back button or the close button close it.
 */
export function Lightbox(props: {
  pictures: () => readonly ViewedPicture[];
  index: () => number | undefined;
  onIndex: (index: number | undefined) => void;
}) {
  return (
    <If when={props.index() !== undefined && props.pictures().length > 0}>
      <LightboxDialog
        pictures={props.pictures}
        index={() =>
          Math.min(props.index() ?? 0, Math.max(0, props.pictures().length - 1))
        }
        onIndex={props.onIndex}
      />
    </If>
  );
}

function LightboxDialog(props: {
  pictures: () => readonly ViewedPicture[];
  index: () => number;
  onIndex: (index: number | undefined) => void;
}) {
  const c = colors();
  const insets = screenInsets();
  const actual = signal(false);
  const stage = signal({ width: 0, height: 0 });
  const count = () => props.pictures().length;
  const picture = () => props.pictures()[props.index()]!;
  const step = (by: number) => {
    const next = props.index() + by;
    if (next < 0 || next >= count()) return;
    actual.set(false);
    props.onIndex(next);
  };
  keymap.bind(
    { left: () => step(-1), right: () => step(1) },
    { when: "always" },
  );
  return (
    <NativeDialog
      animation="fade"
      accessibilityLabel={uiText("pictureTitle", {
        index: props.index() + 1,
        count: count(),
      })}
      accessibilityDescription={uiText("pictureHint")}
      style={{ ...fill, backgroundColor: c().canvas }}
      onOpenChange={({ open }) => {
        if (!open) props.onIndex(undefined);
      }}
    >
      <View
        style={{
          flex: 1,
          minHeight: 0,
          paddingTop: insets().top,
          paddingLeft: insets().left,
          paddingRight: insets().right,
          backgroundColor: c().surface,
        }}
      >
        <View
          role="button"
          testID="picture-stage"
          accessibilityLabel={picture().caption}
          accessibilityState={{ selected: actual() }}
          focusable={false}
          onLayout={(event) =>
            stage.set({
              width: event.bounds.size.width,
              height: event.bounds.size.height,
            })
          }
          onPress={() => actual.update((was) => !was)}
          onPanEnd={(event) => {
            if (actual() || event.cancelled) return;
            const { x, y } = event.translation;
            if (Math.abs(x) < 48 || Math.abs(x) < Math.abs(y)) return;
            step(x < 0 ? 1 : -1);
          }}
          style={{
            flex: 1,
            minHeight: 0,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            cursor: actual() ? "zoom-out" : "zoom-in",
          }}
        >
          <Each of={[`${picture().key}:${actual()}`]}>
            {() => (
              <If
                when={actual()}
                else={
                  <PictureImage
                    picture={picture()}
                    maxWidth={stage().width}
                    maxHeight={stage().height}
                  />
                }
              >
                {/* At its own size the picture scrolls, from its top-left corner. */}
                {/* eslint-disable-next-line no-restricted-syntax -- a pan area: it scrolls both ways, with the horizontal Scroll inside */}
                <Scroll style={{ ...fill }} contentStyle={{ flexGrow: 1 }}>
                  <Scroll horizontal contentStyle={{ flexGrow: 1 }}>
                    <PictureImage
                      picture={picture()}
                      maxWidth={stage().width}
                      maxHeight={stage().height}
                      actual
                    />
                  </Scroll>
                </Scroll>
              </If>
            )}
          </Each>
        </View>
      </View>
      <View
        style={{
          ...row,
          gap: space[12],
          minHeight: barHeight,
          paddingTop: space[4],
          paddingBottom: Math.max(4, insets().bottom),
          paddingLeft: 12 + insets().left,
          paddingRight: 6 + insets().right,
          borderTopWidth: 1,
          borderColor: c().border,
          backgroundColor: c().canvas,
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <PictureCaption>
            {`${count() > 1 ? `${props.index() + 1} / ${count()} · ` : ""}${picture().caption}`}
          </PictureCaption>
        </View>
        <If when={count() > 1}>
          <Button
            label={uiText("previous")}
            tone="ghost"
            labelVariant="caption"
            disabled={props.index() === 0}
            onPress={() => step(-1)}
          />
          <Button
            label={uiText("next")}
            tone="ghost"
            labelVariant="caption"
            disabled={props.index() === count() - 1}
            onPress={() => step(1)}
          />
        </If>
        <CloseButton onPress={() => props.onIndex(undefined)} />
      </View>
    </NativeDialog>
  );
}
