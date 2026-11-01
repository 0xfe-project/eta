import type { ReactNode } from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LanguageProvider } from "@/components/language-provider";
import { AppProviders } from "@/components/providers";
import { WindowControls } from "@/components/window-controls";
import { useSettingsShortcut } from "@/lib/settings-shortcut";

/**
 * Everything a window draws, whatever page it is showing: the providers, the window's buttons, the
 * chord that opens settings, and — through `children` — the page itself. The root route renders
 * this with the routed page as its children, which is what keeps a page from mounting the shared
 * chrome twice or forgetting it.
 */
export function RootDocument({ children }: { children: ReactNode }) {
  return (
    <LanguageProvider>
      <LocalizedDocument>{children}</LocalizedDocument>
    </LanguageProvider>
  );
}

function LocalizedDocument({ children }: { children: ReactNode }) {
  const { t: translateText } = useTranslation(["navigation"] as const);
  useSettingsShortcut();
  // iOS zooms into focused inputs under 16px up to the page's maximum-scale,
  // while Safari still lets users pinch past it. Other browsers would block
  // pinch zoom with this, so it is added on iOS only.
  useEffect(() => {
    const ios =
      /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.userAgent.includes("Macintosh") &&
        navigator.maxTouchPoints > 1);
    const viewport = document.querySelector('meta[name="viewport"]');
    const content = viewport?.getAttribute("content");
    if (ios && content && !content.includes("maximum-scale"))
      viewport?.setAttribute("content", `${content}, maximum-scale=1`);
  }, []);
  return (
    <AppProviders>
      <a
        href="#main"
        // `#main` alone misses on a phone, where the column holding it is hidden; the visible
        // `main` is the one to land on.
        onClick={(event) => {
          const main = [...document.querySelectorAll("main")].find(
            (element) => element.getClientRects().length > 0,
          );
          if (!main) return;
          event.preventDefault();
          main.tabIndex = -1;
          main.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-background focus:p-3 focus:text-foreground"
      >
        {translateText("accessibility.skipToContent")}
      </a>
      {/* The window's buttons sit outside the routed page: they belong to the window, so no page
          can mount them twice or forget them. On macOS and in a browser this draws nothing. */}
      <WindowControls />
      {/* The same reason for ⌘,: every route answers it, and no page can be left out of that. */}
      {children}
    </AppProviders>
  );
}
