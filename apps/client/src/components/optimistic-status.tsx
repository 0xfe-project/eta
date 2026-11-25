import type { ViewStyle } from "nsh";
import { cleanup, createMotion, effect, reduceMotion, signal, View } from "nsh";
import { uiText } from "../i18n";
import { Button } from "./controls";
import { shownWhile } from "./pending";
import { Spinner } from "./spinner";
import { Icon, Label } from "./text";
import { row } from "./theme";
import { control, icon, space } from "./tokens";

export type OptimisticState =
  | { status: "idle" }
  | { status: "saving"; label?: string }
  | { status: "saved"; label?: string }
  | { status: "error"; message?: string };

const SAVED_HOLD_MS = 1600;
const SAVED_FADE_MS = 300;

/**
 * Reactive controller for quiet inline optimistic feedback: transitions `saving` → `saved`
 * (auto-clearing after a brief hold) or `error` (persisting with an optional retry).
 */
export function createOptimisticStatus() {
  const state = signal<OptimisticState>({ status: "idle" });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  cleanup(clearTimer);

  return {
    state,
    saving(label?: string) {
      clearTimer();
      state.set({ status: "saving", label });
    },
    saved(label?: string) {
      clearTimer();
      state.set({ status: "saved", label });
      timer = setTimeout(
        () => state.set({ status: "idle" }),
        SAVED_HOLD_MS + SAVED_FADE_MS,
      );
    },
    fail(message?: string) {
      clearTimer();
      state.set({ status: "error", message });
    },
    reset() {
      clearTimer();
      state.set({ status: "idle" });
    },
  };
}

/**
 * Quiet inline fixed-place status indicator for optimistic saves:
 * - `saving`: after `motion.reveal` (300 ms), shows a 12 px spinner + `"Saving…"`
 * - `saved`: shows a green check + `"Saved"` and gently fades out
 * - `error`: immediately shows red failure text + a `"Retry"` button when `onRetry` is given
 */
export function OptimisticStatus(props: {
  state: OptimisticState;
  onRetry?: () => void;
  style?: ViewStyle;
}) {
  const showSaving = shownWhile(() => props.state.status === "saving");
  const fade = createMotion();

  effect(() => {
    if (props.state.status !== "saved") {
      fade.stop();
      fade.reset();
      return;
    }
    fade.reset();
    if (reduceMotion()) return;
    const timer = setTimeout(() => {
      void fade.play({
        keyframes: { opacity: [1, 0] },
        duration: SAVED_FADE_MS,
        easing: "easeOut",
      });
    }, SAVED_HOLD_MS);
    cleanup(() => {
      clearTimeout(timer);
      fade.stop();
    });
  });

  return (
    <View
      testID="optimistic-status"
      accessibilityLiveRegion="polite"
      style={{
        ...row,
        minHeight: control.sm,
        gap: space[4],
        flexShrink: 0,
        ...props.style,
      }}
    >
      <If when={props.state.status === "saving" && showSaving()}>
        <Spinner size={icon.sm} tone="muted" />
        <Label variant="caption" tone="muted">
          {props.state.status === "saving"
            ? (props.state.label ?? uiText("saving"))
            : ""}
        </Label>
      </If>
      <If when={props.state.status === "saved"}>
        <View style={{ ...row, gap: space[4], ...fade.style }}>
          <Icon name="check" size={icon.sm} tone="green" />
          <Label variant="caption" tone="green">
            {props.state.status === "saved"
              ? (props.state.label ?? uiText("saved"))
              : ""}
          </Label>
        </View>
      </If>
      <If when={props.state.status === "error"}>
        <Label variant="caption" tone="red">
          {props.state.status === "error"
            ? props.state.message || uiText("saveFailed")
            : ""}
        </Label>
        <If when={props.onRetry}>
          <Button
            label={uiText("retry")}
            tone="ghost"
            labelTone="red"
            size={control.sm}
            onPress={() => props.onRetry?.()}
          />
        </If>
      </If>
    </View>
  );
}
