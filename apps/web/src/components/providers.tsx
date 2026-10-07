import type { ReactNode } from "react";
import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import { ThemeProvider } from "next-themes";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

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
        <IconContext value={iconDefaults}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster closeButton />
        </IconContext>
      </NuqsAdapter>
    </ThemeProvider>
  );
}
