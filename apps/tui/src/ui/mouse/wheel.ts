/** Which way one step of the mouse wheel went: up is toward older lines, down toward newer. */
export type WheelDirection = "up" | "down";

/** Wheel steps read from the terminal, for whatever part of the screen listens. */
export interface WheelEvents {
  /** Calls `listener` on every step until the returned function is called. */
  subscribe: (listener: (direction: WheelDirection) => void) => () => void;
}

/** Wheel events no step ever reaches: what the screen has when nothing reads the mouse. */
export const NO_WHEEL_EVENTS: WheelEvents = { subscribe: () => () => {} };

/** Wheel events fed by `emit`. */
export function createWheelEvents(): WheelEvents & {
  emit: (direction: WheelDirection) => void;
} {
  const listeners = new Set<(direction: WheelDirection) => void>();
  return {
    subscribe: (listener) => {
      // A wrapper, so the same function subscribed twice is two subscriptions.
      const one = (direction: WheelDirection) => listener(direction);
      listeners.add(one);
      return () => {
        listeners.delete(one);
      };
    },
    emit: (direction) => {
      for (const listener of [...listeners]) listener(direction);
    },
  };
}
