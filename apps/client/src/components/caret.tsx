import type { Motion, ViewStyle } from "nsh";
import { cleanup, createMotion, effect, reduceMotion, View } from "nsh";
import { motion } from "./motion";
import { colors } from "./theme";
import { space } from "./tokens";

/**
 * A 2px accent text caret that blinks, steady with less motion asked for. Given `blink`, it takes
 * its opacity from that motion instead, so it blinks in step with whatever else the motion drives.
 */
export function Caret(props: {
  testID?: string;
  style?: ViewStyle;
  blink?: Motion;
}) {
  const c = colors();
  const own = createMotion();
  effect(() => {
    if (props.blink || reduceMotion()) {
      own.stop();
      own.reset();
      return;
    }
    void own.play({
      keyframes: { opacity: [1, 0.2, 1] },
      duration: motion.caretBlink,
      easing: "easeInOut",
      iterations: "infinite",
    });
  });
  cleanup(() => own.stop());
  return (
    <View
      testID={props.testID}
      style={{
        width: space[2],
        height: space[16],
        backgroundColor: c().blue,
        ...props.style,
        ...(props.blink
          ? { opacity: props.blink.opacity }
          : reduceMotion()
            ? {}
            : own.style),
      }}
    />
  );
}
