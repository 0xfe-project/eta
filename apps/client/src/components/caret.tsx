import type { ViewStyle } from "nsh";
import { cleanup, createMotion, effect, reduceMotion, View } from "nsh";
import { motion } from "./motion";
import { colors } from "./theme";
import { space } from "./tokens";

/**
 * A 2px accent text caret that blinks. It stays lit while `still` says it should (something
 * around it is moving) and with less motion asked for.
 */
export function Caret(props: {
  testID?: string;
  still?: () => boolean;
  style?: ViewStyle;
}) {
  const c = colors();
  const blink = createMotion();
  effect(() => {
    if (reduceMotion() || props.still?.()) {
      blink.stop();
      blink.reset();
      return;
    }
    void blink.play({
      keyframes: { opacity: [1, 0.2, 1] },
      duration: motion.caretBlink,
      easing: "easeInOut",
      iterations: "infinite",
    });
  });
  cleanup(() => blink.stop());
  return (
    <View
      testID={props.testID}
      style={{
        width: space[2],
        height: space[16],
        backgroundColor: c().blue,
        ...props.style,
        ...(reduceMotion() ? {} : blink.style),
      }}
    />
  );
}
