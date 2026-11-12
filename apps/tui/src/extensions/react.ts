/**
 * What views, layers and pinned tabs reach from React. Every hook here works anywhere under the
 * running shell; `useShell` needs the connected shell, the others work on every screen.
 */
import type { ActionName, Theme, TuiConfig } from "../config/types";
import type { Registry } from "./registry";
import type { ShellContext } from "./types";
import { useInput } from "ink";
import { createContext, use } from "react";
import { matchesBinding } from "../ui/key-match";

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
