/**
 * What views, layers and pinned tabs reach from React. Every hook here works anywhere under the
 * running shell; `useShell` needs the connected shell, the others work on every screen.
 */
import type { ActionName, Theme, TuiConfig } from "../config/types";
import type { WheelDirection, WheelEvents } from "../ui/mouse/wheel";
import type { Registry } from "./registry";
import type { ShellContext } from "./types";
import { useInput } from "ink";
import { createContext, use, useEffect, useRef } from "react";
import { matchesBinding } from "../ui/key-match";
import { NO_WHEEL_EVENTS } from "../ui/mouse/wheel";

/** Provided by the App around the connected shell. */
export const RunningShellContext = createContext<ShellContext | undefined>(
  undefined,
);
/** Provided by the App: the settings in effect. */
export const ConfigContext = createContext<TuiConfig | undefined>(undefined);
/** Provided by the App: the features' registry. */
export const RegistryContext = createContext<Registry | undefined>(undefined);
/** Whether the part of the screen under it receives keys; set through `InputScope`. */
export const InputActiveContext = createContext(true);
/** Provided around the App by the entry point: the terminal's wheel steps. Without it none arrive. */
export const WheelContext = createContext<WheelEvents>(NO_WHEEL_EVENTS);

/** How many lines one wheel step scrolls. */
export const LINES_PER_WHEEL_STEP = 3;

/** The running shell's context. Throws outside the connected shell. */
export function useShell(): ShellContext {
  const ctx = use(RunningShellContext);
  if (!ctx)
    throw new Error("useShell is only available inside the connected shell");
  return ctx;
}

/** The settings in effect; a component re-renders when `/config` applies new ones. */
export function useConfig(): TuiConfig {
  const config = use(ConfigContext);
  if (!config) throw new Error("useConfig needs the App around it");
  return config;
}

/** The colour slots in effect. Pass a value through `inkColor` before giving it to Ink. */
export function useTheme(): Theme {
  return useConfig().theme;
}

export function useRegistry(): Registry {
  const registry = use(RegistryContext);
  if (!registry) throw new Error("useRegistry needs the App around it");
  return registry;
}

/**
 * Whether this part of the screen receives keys now. A component that reads keys with Ink's
 * `useInput` passes this in `isActive`, so a layer over it, or the reconnecting screen, takes the
 * keys away from it.
 */
export function useInputActive(): boolean {
  return use(InputActiveContext);
}

/**
 * Calls `handler` when a key bound to `action` in the settings is pressed. It follows rebinding
 * through `/config`, and does nothing while this part of the screen does not receive keys.
 * `isActive: false` turns it off too, for a view that is not in front.
 */
export function useAction(
  action: ActionName,
  handler: () => void,
  options: { isActive?: boolean } = {},
): void {
  const bindings = useConfig().keybindings[action];
  const scopeActive = useInputActive();
  useInput(
    (input, key) => {
      if (bindings.some((binding) => matchesBinding(binding, input, key)))
        handler();
    },
    { isActive: scopeActive && (options.isActive ?? true) },
  );
}

/**
 * Calls `handler` with the mouse wheel's steps over the terminal: their direction, and how many
 * there were. The steps that arrive together (one read of the terminal) reach `handler` in one
 * call, as their sum, right after they arrive; the hook renders nothing of its own for them.
 * Steps of reads that follow one another can come before the screen draws again, so a `handler`
 * that moves something moves it on from where the call before left it, not from what its render
 * saw. The `handler` of the latest render is called. Like `useAction`, it does nothing while this
 * part of the screen does not receive keys, or with `isActive: false`. Steps still waiting to be
 * passed on are dropped once the component goes away or a commit turns it off.
 */
export function useWheel(
  handler: (direction: WheelDirection, steps: number) => void,
  options: { isActive?: boolean } = {},
): void {
  const wheel = use(WheelContext);
  const active = useInputActive() && (options.isActive ?? true);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Ink's legacy root puts every update on React's sync lane, and a sync-lane commit runs its
  // passive effects before it returns. So the commit that unmounts this or turns it off has run
  // this effect's cleanup, and `subscribed` is false, before a waiting step is passed on.
  useEffect(() => {
    if (!active) return;
    // Down counted positive and up negative.
    let pending = 0;
    let scheduled = false;
    let subscribed = true;
    const passOn = () => {
      scheduled = false;
      const steps = pending;
      pending = 0;
      if (!subscribed || steps === 0) return;
      handlerRef.current(steps > 0 ? "down" : "up", Math.abs(steps));
    };
    const unsubscribe = wheel.subscribe((direction) => {
      pending += direction === "down" ? 1 : -1;
      if (scheduled) return;
      scheduled = true;
      // A read hands over all its steps before it returns; the microtask runs after the last.
      queueMicrotask(passOn);
    });
    return () => {
      subscribed = false;
      unsubscribe();
    };
  }, [wheel, active]);
}
