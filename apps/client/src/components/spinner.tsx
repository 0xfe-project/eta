import type { MotionSpec } from "nsh";
import type { IconName } from "./icons";
import type { light } from "./theme";
import {
  cleanup,
  createMotion,
  effect,
  reduceMotion,
  untracked,
  View,
} from "nsh";
import { motion } from "./motion";
import { Icon } from "./text";

// The app's one spinner (#380): the icon set's `spinner`, turning. When the user asks for less
// motion it stands still; what it says (busy) is still said to a screen reader by its owner.

/** One turn, at an even speed. */
const turn: MotionSpec = {
  keyframes: { rotate: [0, 360] },
  duration: motion.spin,
  easing: "linear",
};

/** A spinner: turns for as long as it is drawn. Draw it through `shownWhile` (pending.ts). */
export function Spinner(props: { size?: number; tone?: keyof typeof light }) {
  const spin = createMotion();
  void spin.play({ ...turn, iterations: "infinite" });
  cleanup(() => spin.stop());
  return (
    <View style={spin.style} accessibilityElementsHidden>
      <Icon name="spinner" size={props.size} tone={props.tone} />
    </View>
  );
}

/**
 * A button's own icon that stands for its action (refresh, check again): it starts turning as
 * the action starts, turns at least once, and stops only on a whole turn.
 */
export function SpinningIcon(props: {
  name: IconName;
  running: boolean;
  size?: number;
  tone?: keyof typeof light;
}) {
  const spin = createMotion();
  let turning = false;
  let gone = false;
  function step() {
    turning = true;
    void spin.play(turn).then(({ finished }) => {
      turning = false;
      // A whole turn looks like none: back to 0 for the next.
      spin.reset();
      if (
        finished &&
        !gone &&
        untracked(() => props.running) &&
        !reduceMotion()
      )
        step();
    });
  }
  effect(() => {
    if (props.running && !turning && !reduceMotion()) untracked(step);
  });
  cleanup(() => {
    gone = true;
    spin.stop();
  });
  return (
    <View style={spin.style}>
      <Icon name={props.name} size={props.size} tone={props.tone} />
    </View>
  );
}
