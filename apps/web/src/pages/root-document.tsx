import { Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LanguageProvider } from "@/components/language-provider";
import { AppProviders } from "@/components/providers";
import { LiveChat } from "@/components/workspace/live-chat";

export function RootDocument() {
  return (
    <LanguageProvider>
      <LocalizedDocument />
    </LanguageProvider>
  );
}

function LocalizedDocument() {
  const { t: translateText } = useTranslation(["navigation"] as const);
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
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-background focus:p-3 focus:text-foreground"
      >
        {translateText("accessibility.skipToContent")}
      </a>
      <LiveChat />
      <Outlet />
    </AppProviders>
  );
}
