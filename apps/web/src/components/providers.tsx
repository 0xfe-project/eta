import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import type { ReactNode } from "react";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const iconDefaults = { size: 20, weight: "regular" } as const;

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      forcedTheme="light"
      enableSystem={false}
      disableTransitionOnChange
    >
      <NuqsAdapter>
        <IconContext.Provider value={iconDefaults}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster closeButton />
        </IconContext.Provider>
      </NuqsAdapter>
    </ThemeProvider>
  );
}
