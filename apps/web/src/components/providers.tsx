import type { ReactNode } from "react";
import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

const iconDefaults = { size: 20, weight: "regular" } as const;

/**
 * Everything the app sits inside.
 *
 * No theme provider: the color mode is not a tree of context here. It is a class on `<html>`,
 * painted by the inline script in index.html before the first frame, and read afterwards
 * through `useTheme` (components/use-theme.ts). A provider would have to render that decision
 * again, on the client, after the paint it was meant to prevent.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <NuqsAdapter>
      <IconContext value={iconDefaults}>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster closeButton />
      </IconContext>
    </NuqsAdapter>
  );
}
