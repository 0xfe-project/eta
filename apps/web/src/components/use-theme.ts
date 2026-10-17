import type { ResolvedTheme, ThemeChoice } from "@/lib/theme";
import { useSyncExternalStore } from "react";
import { readTheme, resolveTheme, setTheme, subscribeTheme } from "@/lib/theme";

/**
 * The color mode as components see it: the choice that was made, the mode it resolves to, and
 * the way to change it. A drop-in for the three fields this app used from `next-themes`.
 */
export function useTheme(): {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme: (choice: ThemeChoice) => void;
} {
  const theme = useSyncExternalStore(
    subscribeTheme,
    readTheme,
    // Nothing is stored on a server: the first paint always assumes the system.
    () => "system" as const,
  );
  return { theme, resolvedTheme: resolveTheme(theme), setTheme };
}
