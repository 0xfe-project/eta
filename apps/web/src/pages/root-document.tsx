import type { CSSProperties } from "react";
import { HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LanguageProvider } from "@/components/language-provider";
import { AppProviders } from "@/components/providers";
import { LiveChat } from "@/components/workspace/live-chat";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";
import { useOutbox } from "@/queries/outbox";

export function RootDocument() {
  return (
    <LanguageProvider>
      <LocalizedDocument />
    </LanguageProvider>
  );
}

function LocalizedDocument() {
  const { t: translateText, i18n } = useTranslation();
  // Saved workspace state and drafts load after hydration, so the first client render
  // matches the server's.
  useEffect(() => {
    void useWorkspaceStore.persist.rehydrate();
    void useOutbox.persist.rehydrate();
  }, []);
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
  const fontSans = useWorkspaceStore((s) => s.workspace.fontSans);
  const fontMono = useWorkspaceStore((s) => s.workspace.fontMono);
  const fonts = {
    "--user-font-sans": fontSans,
    "--user-font-mono": fontMono,
  } as CSSProperties;
  return (
    <html
      lang={i18n.resolvedLanguage === "zh" ? "zh-CN" : "en"}
      style={fonts}
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
        {/* Rendered here because head() keeps one meta per name. */}
        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#0a0a0a"
          media="(prefers-color-scheme: dark)"
        />
      </head>
      <body>
        <AppProviders>
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:bg-background focus:p-3 focus:text-foreground"
          >
            {translateText("跳转到内容")}
          </a>
          <LiveChat />
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
