import type { ViewRef } from "nsh";
import type { Tie } from "../../picture-cards";
import {
  cleanup,
  context,
  createMotion,
  LayoutAnimation,
  reduceMotion,
  signal,
  View,
  windowSize,
} from "nsh";
import { Caret } from "../../caret";
import { motion } from "../../motion";
import { colors } from "../../theme";
import { space } from "../../tokens";

// A sent message's pictures and the places they stood in its text. Nothing marks a place in the
// words; while the pointer or the focus rests on a picture's card, one line goes from the card up
// to a caret at its place, and moving to another card moves that same line and caret there.
// Made once per shown text.

/**
 * The box that holds the messages (the list a transcript scrolls in): a place outside it is out
 * of sight, and no line is drawn to it. Without one, the window is that box.
 */
export const MessageViewport = context<(() => ViewRef | undefined) | undefined>(
  undefined,
);

/** What `ViewRef.measure` says of a view (`null` when it is not on screen). */
type Measured = Awaited<ReturnType<ViewRef["measure"]>>;

/** A line's ends, in the overlay's points: the corner of the card's top edge nearest the lane,
 * where the line starts; the lane it rises in; and the bottom of the caret it rises to. */
interface Ends {
  fromX: number;
  fromY: number;
  laneX: number;
  toY: number;
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The line as boxes: along the card's top edge to the lane, a corner, and up the lane. */
interface Stroke {
  along: Box;
  turn: Box;
  rise: Box;
  /** The way the line goes along: 1 to the right, -1 to the left. */
  way: 1 | -1;
}

/** The padding of a sent message's bubble beside its text; the overlay reaches over it. */
const BUBBLE_PADDING = space[12];
/** Where the lane runs: this far in from the overlay's right edge, the middle of the padding. */
const LANE = BUBBLE_PADDING / 2;
/** The rounding of the line's corner, and how far in the card's corner it starts. */
const CORNER = space[4];
/** The line's width. */
const HAIR = 1;

/**
 * The line from the card's corner along its top edge (the gap between the words and the cards) to
 * the lane, and up the lane to the caret's bottom. It never enters the words. The corner shrinks
 * to what the run along and the rise leave it.
 */
function strokeOf({ fromX, fromY, laneX, toY }: Ends): Stroke {
  const way = laneX >= fromX ? 1 : -1;
  const r = Math.max(0, Math.min(CORNER, Math.abs(laneX - fromX), fromY - toY));
  const end = way > 0 ? laneX + HAIR - r : laneX + r;
  return {
    way,
    along: {
      left: Math.min(fromX, end),
      top: fromY,
      width: Math.abs(end - fromX),
      height: HAIR,
    },
    turn: {
      left: way > 0 ? laneX + HAIR - r : laneX,
      top: fromY + HAIR - r,
      width: r,
      height: r,
    },
    rise: {
      left: laneX,
      top: toY,
      width: HAIR,
      height: fromY + HAIR - r - toY,
    },
  };
}

/** The line drawn back into the card's corner. */
function drawnBack({ fromX, fromY }: Ends, way: 1 | -1): Stroke {
  const at: Box = { left: fromX, top: fromY, width: 0, height: 0 };
  return { along: at, turn: at, rise: at, way };
}

/** The line's ends for `picture` and `mark`, or none where the mark is above no picture or is out
 * of sight in `view`. */
function endsOf(
  picture: NonNullable<Measured>,
  mark: NonNullable<Measured>,
  overlay: NonNullable<Measured>,
  view: { x: number; y: number; width: number; height: number },
): Ends | undefined {
  const inView =
    mark.pagePosition.x >= view.x &&
    mark.pagePosition.y >= view.y &&
    mark.pagePosition.x <= view.x + view.width &&
    mark.pagePosition.y + mark.bounds.size.height <= view.y + view.height;
  const laneX = overlay.bounds.size.width - LANE;
  const left = picture.pagePosition.x - overlay.pagePosition.x;
  const ends = {
    fromX:
      laneX >= left + picture.bounds.size.width / 2
        ? left + picture.bounds.size.width - CORNER
        : left + CORNER,
    fromY: picture.pagePosition.y - overlay.pagePosition.y,
    laneX,
    toY: mark.pagePosition.y + mark.bounds.size.height - overlay.pagePosition.y,
  };
  return inView && ends.toY < ends.fromY ? ends : undefined;
}

/** The kinds of move `LayoutAnimation` knows, by the curve the line's motion asks for: out for
 * `motion.open`, in for `motion.close`, in and out for `motion.move`. */
const slide = {
  open: "easeOut",
  close: "easeIn",
  move: "easeInEaseOut",
} as const;

/** The next layout change plays over `duration` (at once where less motion is asked for). */
function slideNext(duration: number, curve: keyof typeof slide) {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext({ duration, update: { type: slide[curve] } });
}

/** The tie of every picture card of one shown text to the place its picture stood. */
export function pictureLinks() {
  const viewport = MessageViewport();
  const cards = new Map<string, ViewRef>();
  const marks = new Map<string, ViewRef>();
  /** The card whose line is drawn (or being moved to), for its outline. */
  const linked = signal<string>();
  /** The card the pointer or the focus is on. */
  let resting: string | undefined;
  const stroke = signal<Stroke>();
  /** The caret's place, in the overlay's points. */
  const caret = signal<{ x: number; top: number }>();
  /** The caret blinks only while nothing about it moves. */
  const moving = signal(true);
  const fade = createMotion({ initial: { opacity: 0 } });
  let overlay: ViewRef | undefined;
  let ends: Ends | undefined;
  let wait: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  /** Each draw, move or draw back replaces the one before: only the latest goes on. */
  let turn = 0;
  cleanup(() => {
    turn++;
    clearTimeout(wait);
    clearTimeout(grace);
    for (const timer of pending) clearTimeout(timer);
    fade.stop();
  });

  /** Runs `step` after `ms`, unless another draw, move or draw back has begun by then. */
  function later(ms: number, step: () => void) {
    const mine = turn;
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (mine === turn) step();
    }, ms);
    pending.add(timer);
  }

  function showCaret(on: boolean) {
    void fade.play({
      keyframes: { opacity: on ? [0, 1] : [1, 0] },
      duration: motion.connector.caret,
      easing: on ? motion.open : motion.close,
    });
  }

  /** Where the line from `key`'s card to its place is, now. */
  async function measureEnds(key: string): Promise<Ends | undefined> {
    const [picture, mark, box, view] = await Promise.all([
      cards.get(key)?.measure(),
      marks.get(key)?.measure(),
      overlay?.measure(),
      viewport?.()?.measure(),
    ]);
    if (!picture || !mark || !box) return undefined;
    const sight = view
      ? { ...view.pagePosition, ...view.bounds.size }
      : { x: 0, y: 0, ...windowSize() };
    return endsOf(picture, mark, box, sight);
  }

  /** The line comes out of the card to its place. */
  async function draw(key: string) {
    const mine = ++turn;
    const found = await measureEnds(key);
    if (mine !== turn || !found) return;
    ends = found;
    linked.set(key);
    moving.set(true);
    caret.set({ x: found.laneX, top: found.toY - space[16] });
    const full = strokeOf(found);
    if (reduceMotion()) {
      stroke.set(full);
      fade.opacity.set(1);
      moving.set(false);
      return;
    }
    stroke.set(drawnBack(found, full.way));
    // The line drawn back is on screen before it grows.
    await new Promise((done) => setTimeout(done, 0));
    if (mine !== turn) return;
    slideNext(motion.connector.stretch, "move");
    stroke.set(full);
    later(motion.connector.stretch - motion.connector.caret, () =>
      showCaret(true),
    );
    later(motion.connector.stretch, () => moving.set(false));
  }

  /** The line, drawn or drawing back, goes on to `key`'s card and place. */
  async function moveTo(key: string) {
    const mine = ++turn;
    const found = await measureEnds(key);
    if (mine !== turn || !found) return;
    // A card on another row is twice as far.
    const duration =
      ends && Math.abs(found.fromY - ends.fromY) > 1
        ? motion.connector.hop
        : motion.connector.stretch;
    ends = found;
    linked.set(key);
    moving.set(true);
    slideNext(duration, "move");
    stroke.set(strokeOf(found));
    caret.set({ x: found.laneX, top: found.toY - space[16] });
    showCaret(true);
    later(duration, () => moving.set(false));
  }

  /** The line goes back into the card, and the caret goes out. */
  function drawBack() {
    if (!stroke() || !ends) return;
    turn++;
    linked.set(undefined);
    moving.set(true);
    if (reduceMotion()) return end();
    slideNext(motion.connector.retract, "close");
    stroke.set(drawnBack(ends, stroke()!.way));
    later(motion.connector.retract - motion.connector.caret, () =>
      showCaret(false),
    );
    later(motion.connector.retract, end);
  }

  function end() {
    stroke.set(undefined);
    caret.set(undefined);
    fade.stop();
    fade.reset();
    fade.opacity.set(0);
    ends = undefined;
  }

  function rest(key: string, on: boolean) {
    // A picture that stood nowhere (an older message) has no place to go to.
    if (!cards.has(key) || !marks.has(key)) return;
    if (on) {
      resting = key;
      clearTimeout(grace);
      clearTimeout(wait);
      if (!stroke())
        wait = setTimeout(() => void draw(key), motion.connector.rest);
      else if (linked() !== key) void moveTo(key);
    } else if (resting === key) {
      resting = undefined;
      clearTimeout(wait);
      // Moving on to another card within the grace moves the line instead of drawing it back.
      grace = setTimeout(drawBack, motion.connector.rest);
    }
  }

  return {
    /** The card's tie to the place its picture stood. */
    tie(key: string): Tie {
      return {
        ref: (node) => {
          cards.set(key, node);
        },
        active: () => linked() === key,
        onRest: (on) => rest(key, on),
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
    /** The line and its caret, over the whole shown text; they take no press. */
    Line() {
      const c = colors();
      const edge = { borderColor: c().blue, borderWidth: 0 };
      const part = (box: Box) => ({
        position: "absolute" as const,
        ...box,
      });
      return (
        <View
          ref={(node) => {
            overlay = node;
          }}
          style={{
            position: "absolute",
            top: 0,
            // Out over the bubble's padding, where the lane runs.
            right: -BUBBLE_PADDING,
            bottom: 0,
            left: 0,
            pointerEvents: "none",
          }}
        >
          <If when={stroke()}>
            {(drawn) => (
              <View testID="picture-link">
                <View
                  testID="picture-link-stroke"
                  style={{ ...part(drawn().along), backgroundColor: c().blue }}
                />
                <View
                  testID="picture-link-stroke"
                  style={{ ...part(drawn().rise), backgroundColor: c().blue }}
                />
                <View
                  testID="picture-link-corner"
                  style={{
                    ...part(drawn().turn),
                    ...edge,
                    borderBottomWidth: HAIR,
                    ...(drawn().way > 0
                      ? {
                          borderRightWidth: HAIR,
                          borderBottomRightRadius: CORNER,
                        }
                      : {
                          borderLeftWidth: HAIR,
                          borderBottomLeftRadius: CORNER,
                        }),
                  }}
                />
              </View>
            )}
          </If>
          <If when={caret()}>
            {(at) => (
              <View
                testID="picture-link-caret"
                style={{
                  position: "absolute",
                  left: at().x - space[2] / 2,
                  top: at().top,
                  ...fade.style,
                }}
              >
                <Caret testID="picture-link-blink" still={moving} />
              </View>
            )}
          </If>
        </View>
      );
    },
  };
}
