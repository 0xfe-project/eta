import type { MotionSpec } from "nsh";
import type { IconName } from "./icons";
import type { light } from "./theme";
import {
  cleanup,
  createMotion,
  Easing,
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

const { rampDeg, rampMs, sustainFirstMs, sustainNextMs, finishLinearMs } =
  motion.spinAction;

/** First 18%: accelerates smoothly from rest to 600°/s (36° in 120 ms, quadratic). */
const spinRampUp: MotionSpec = {
  keyframes: { rotate: [0, rampDeg] },
  duration: rampMs,
  easing: Easing.quad,
};

/** Middle of the first turn at a steady 600°/s. */
const spinSustainFirst: MotionSpec = {
  keyframes: { rotate: [rampDeg, 360 - rampDeg] },
  duration: sustainFirstMs,
  easing: "linear",
};

/** Bridges a continuing turn linearly through 360° back to 0° without pausing. */
const spinFinishLinear: MotionSpec = {
  keyframes: { rotate: [360 - rampDeg, 360] },
  duration: finishLinearMs,
  easing: "linear",
};

/** Subsequent turns sustain at 600°/s until the action finishes. */
const spinSustainNext: MotionSpec = {
  keyframes: { rotate: [0, 360 - rampDeg] },
  duration: sustainNextMs,
  easing: "linear",
};

/** Last 18%: decelerates smoothly from 600°/s to rest on a whole turn (360°). */
const spinRampDown: MotionSpec = {
  keyframes: { rotate: [360 - rampDeg, 360] },
  duration: rampMs,
  easing: Easing.out(Easing.quad),
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
 * A button's own icon that stands for its action (refresh, check again): it starts turning
 * immediately on press, accelerates over the first ~18%, sustains at ~600°/s while running,
 * and decelerates over the last ~18% to land on a whole turn (at least 640 ms for one full
 * turn). Stays stationary when reduced motion is enabled.
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

  async function runCycle() {
    turning = true;
    try {
      const up = await spin.play(spinRampUp);
      if (!up.finished || gone || reduceMotion()) return;
      const first = await spin.play(spinSustainFirst);
      if (!first.finished || gone || reduceMotion()) return;

      while (untracked(() => props.running) && !reduceMotion()) {
        if (gone) return;
        const bridge = await spin.play(spinFinishLinear);
        if (!bridge.finished || gone || reduceMotion()) return;
        spin.reset();
        const next = await spin.play(spinSustainNext);
        if (!next.finished || gone || reduceMotion()) return;
      }

      await spin.play(spinRampDown);
    } finally {
      spin.reset();
      turning = false;
      if (!gone && untracked(() => props.running) && !reduceMotion()) {
        void runCycle();
      }
    }
  }

  effect(() => {
    if (props.running && !turning && !reduceMotion()) untracked(runCycle);
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
