import type { KeyEvent } from "nsh";

interface AdjustableOptions {
  orientation?: "horizontal" | "vertical";
  min: () => number;
  max: () => number;
  value: () => number;
  step?: number;
  largeStep?: number;
  onChange: (next: number) => void;
}

/**
 * Keyboard step-adjustment behavior for `role="adjustable"` controls (split-pane handles, sliders).
 */
export function createAdjustable(options: AdjustableOptions) {
  const orientation = options.orientation ?? "horizontal";
  const step = options.step ?? 16;
  const largeStep = options.largeStep ?? 64;
  const decKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowDown";
  const incKey = orientation === "horizontal" ? "ArrowRight" : "ArrowUp";
  const decStroke = orientation === "horizontal" ? "left" : "down";
  const incStroke = orientation === "horizontal" ? "right" : "up";

  function clamp(next: number) {
    return Math.max(options.min(), Math.min(options.max(), next));
  }

  function onKeyDown(event: KeyEvent): boolean {
    const amount = event.modifiers.shift ? largeStep : step;
    if (event.key === decKey) {
      options.onChange(clamp(options.value() - amount));
      return true;
    }
    if (event.key === incKey) {
      options.onChange(clamp(options.value() + amount));
      return true;
    }
    if (event.key === "Home") {
      options.onChange(options.min());
      return true;
    }
    if (event.key === "End") {
      options.onChange(options.max());
      return true;
    }
    return false;
  }

  return {
    onKeyDown,
    captureKeys: [decStroke, incStroke, "home", "end"] as readonly string[],
    accessibilityValue: () => ({
      min: options.min(),
      max: options.max(),
      now: options.value(),
    }),
  };
}
