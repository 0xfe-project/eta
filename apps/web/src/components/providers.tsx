import { IconContext } from "@phosphor-icons/react/dist/lib/context";
import { lazy, Suspense, type ReactNode } from "react";
import { NuqsAdapter } from "nuqs/adapters/tanstack-router";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

const QueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import("@tanstack/react-query-devtools").then((module) => ({
        default: module.ReactQueryDevtools,
      })),
    )
  : null;
const iconDefaults = { size: 20, weight: "regular" } as const;

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <NuqsAdapter>
        <IconContext.Provider value={iconDefaults}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster closeButton />
          {QueryDevtools ? (
            <Suspense fallback={null}>
              <QueryDevtools
                initialIsOpen={false}
                buttonPosition="bottom-left"
              />
            </Suspense>
          ) : null}
        </IconContext.Provider>
      </NuqsAdapter>
    </ThemeProvider>
  );
}
