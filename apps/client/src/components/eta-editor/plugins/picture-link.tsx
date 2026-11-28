import type { ViewRef } from "nsh";
import type { Tie } from "../../picture-cards";
import {
  cleanup,
  context,
  createMotion,
  reduceMotion,
  signal,
  View,
  windowSize,
} from "nsh";
import { PicturePlaces } from "../../../services/picture-mode";
import { Caret } from "../../caret";
import { motion } from "../../motion";
import { colors } from "../../theme";
import { border, space } from "../../tokens";

// A sent message's pictures and the places they stood in its text. Nothing marks a place in the
// words at rest. While the pointer or the focus rests on a picture's card, or a finger holds it,
// a caret grows up from the baseline at the place, between the two characters the picture stood
// between, and blinks; a ring over the card's outline blinks with it. Nothing is drawn between them, and no
// character moves. The caret is a hairline: the gap between two characters of the shipped face is
// one point, and a wider caret would cover their edges. Made once per shown text.

/**
 * The box that holds the messages (the list a transcript scrolls in): a place outside it is out
 * of sight, and no caret is drawn there. Without one, the window is that box.
 */
export const MessageViewport = context<(() => ViewRef | undefined) | undefined>(
  undefined,
);

/** What `ViewRef.measure` says of a view on screen. */
type Measured = NonNullable<Awaited<ReturnType<ViewRef["measure"]>>>;

/** The padding of a sent message's bubble beside its text. The caret is drawn over the text and
 * that padding, not inside the text, which cuts off what crosses its edge: a caret at a line's
 * start or end is drawn whole. */
const BUBBLE_PADDING = space[12];
/** A line of a message's text: body prose (theme.ts `typeScale`). The caret is as tall. */
const LINE = 22;

/** Where the caret stands, in the overlay's points: its place's x, and its line's top; and the
 * card's box, which the ring goes round. */
interface Place {
  key: string;
  x: number;
  top: number;
  card: { left: number; top: number; width: number; height: number };
}

/** The caret's place for `mark` (a zero-width view on its line), or none where the place is out of
 * sight in `view`. */
function placeOf(
  key: string,
  card: Measured,
  mark: Measured,
  overlay: Measured,
  view: { x: number; y: number; width: number; height: number },
): Place | undefined {
  const inView =
    mark.pagePosition.x >= view.x &&
    mark.pagePosition.y >= view.y &&
    mark.pagePosition.x <= view.x + view.width &&
    mark.pagePosition.y + mark.bounds.size.height <= view.y + view.height;
  if (!inView) return undefined;
  return {
    key,
    x: mark.pagePosition.x - overlay.pagePosition.x,
    top:
      mark.pagePosition.y -
      overlay.pagePosition.y +
      (mark.bounds.size.height - LINE) / 2,
    card: {
      left: card.pagePosition.x - overlay.pagePosition.x,
      top: card.pagePosition.y - overlay.pagePosition.y,
      ...card.bounds.size,
    },
  };
}

/** The tie of every picture card of one shown text to the place its picture stood. */
export function pictureLinks() {
  const places = PicturePlaces();
  const viewport = MessageViewport();
  const c = colors();
  const cards = new Map<string, ViewRef>();
  const marks = new Map<string, ViewRef>();
  /** The card whose place shows. */
  const shown = signal<string>();
  /** The caret drawn, kept while it fades out. */
  const place = signal<Place>();
  /** The card the pointer, the focus or a finger is on. */
  let resting: string | undefined;
  /** The card a finger holds (a long press), until it lifts. */
  let held: string | undefined;
  let overlay: ViewRef | undefined;
  let wait: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  /** Each show or fade replaces the one before: only the latest goes on. */
  let turn = 0;
  /** The caret growing up from the baseline. */
  const grow = createMotion({ initial: { scaleY: 0 } });
  /** The caret's and the card ring's light: one value, so they blink in step. */
  const blink = createMotion();
  /** The caret blinks (for tests: the blink itself plays natively). */
  const blinks = signal(false);
  cleanup(() => {
    turn++;
    clearTimeout(wait);
    clearTimeout(grace);
    grow.stop();
    blink.stop();
  });

  async function measure(key: string) {
    const [card, mark, box, view] = await Promise.all([
      cards.get(key)?.measure(),
      marks.get(key)?.measure(),
      overlay?.measure(),
      viewport?.()?.measure(),
    ]);
    if (!card || !mark || !box) return undefined;
    const sight = view
      ? { ...view.pagePosition, ...view.bounds.size }
      : { x: 0, y: 0, ...windowSize() };
    return placeOf(key, card, mark, box, sight);
  }

  /** The caret grows at `key`'s place, then it and the card blink. */
  async function show(key: string) {
    const mine = ++turn;
    const found = await measure(key);
    if (mine !== turn) return;
    blink.stop();
    blink.reset();
    blinks.set(false);
    place.set(found);
    if (!found) return;
    if (reduceMotion()) {
      grow.scaleY.set(1);
      return;
    }
    grow.scaleY.set(0);
    void grow.play({
      keyframes: { scaleY: [0, 1] },
      spring: motion.pictureCue.grow,
    });
    blinks.set(true);
    void blink.play({
      keyframes: { opacity: [1, motion.pictureCue.blink.low, 1] },
      duration: motion.pictureCue.blink.period,
      easing: "easeInOut",
      iterations: "infinite",
    });
  }

  /** The caret and the ring fade out. */
  async function hide() {
    const mine = ++turn;
    blink.stop();
    blinks.set(false);
    if (!reduceMotion())
      await blink.opacity.timing(0, {
        duration: motion.pictureCue.leave,
        easing: motion.close,
      });
    if (mine !== turn) return;
    place.set(undefined);
    blink.reset();
  }

  function rest(key: string, on: boolean, after: number) {
    // Turned off in Settings, or a picture that stood nowhere (an older message): nothing shows.
    if (!places.on() || !cards.has(key) || !marks.has(key)) return;
    if (on) {
      resting = key;
      clearTimeout(grace);
      clearTimeout(wait);
      if (shown() === key) return;
      const go = () => {
        shown.set(key);
        void show(key);
      };
      // Moving on to another card while a caret shows, or a held finger, shows it at once.
      if (shown() || after === 0) go();
      else wait = setTimeout(go, after);
    } else if (resting === key) {
      resting = undefined;
      clearTimeout(wait);
      grace = setTimeout(() => {
        shown.set(undefined);
        void hide();
      }, after);
    }
  }

  return {
    /** The card's tie to the place its picture stood. */
    tie(key: string): Tie {
      return {
        ref: (node) => {
          cards.set(key, node);
        },
        onRest: (on) => rest(key, on, motion.pictureCue.rest),
        onHold: (on) => {
          // A press that was no long press lifts too: it opens the picture, and changes nothing here.
          if (!on && held !== key) return;
          held = on ? key : undefined;
          rest(key, on, on ? 0 : motion.pictureCue.linger);
        },
      };
    },
    /** The place a picture stood in the words: nothing is drawn there, it only has a position. */
    Mark(props: { id: string }) {
      cleanup(() => marks.delete(props.id));
      return (
        <View
          testID="picture-mark"
          ref={(node) => {
            marks.set(props.id, node);
          }}
          style={{ width: 0, height: space[16] }}
        />
      );
    },
    /** The caret and the ring, over the whole shown text, its cards and its bubble's padding;
     * they take no press. */
    Place() {
      return (
        <View
          ref={(node) => {
            overlay = node;
          }}
          style={{
            position: "absolute",
            top: 0,
            right: -BUBBLE_PADDING,
            bottom: 0,
            left: -BUBBLE_PADDING,
            pointerEvents: "none",
          }}
        >
          <If when={place()}>
            {(at) => (
              <View
                testID="picture-card-ring"
                style={{
                  position: "absolute",
                  ...at().card,
                  borderWidth: border.hair,
                  borderColor: c().blue,
                  opacity: blink.opacity,
                }}
              />
            )}
          </If>
          <If when={place()}>
            {(at) => (
              <Caret
                testID={
                  blinks() ? "picture-caret-blinking" : "picture-caret-still"
                }
                blink={blink}
                style={{
                  position: "absolute",
                  left: at().x - border.hair / 2,
                  top: at().top,
                  width: border.hair,
                  height: LINE,
                  transformOrigin: "bottom",
                  transform: grow.transform,
                }}
              />
            )}
          </If>
        </View>
      );
    },
  };
}
