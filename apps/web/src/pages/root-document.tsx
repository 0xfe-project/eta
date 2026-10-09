import type { CSSProperties } from "react";
import { HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppProviders } from "@/components/providers";
import { LiveChat } from "@/components/workspace/live-chat";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";
import { useOutbox } from "@/queries/outbox";

export function RootDocument() {
  // Saved workspace state and drafts load after hydration, so the first client render
  // matches the server's.
  useEffect(() => {
    void useWorkspaceStore.persist.rehydrate();
    void useOutbox.persist.rehydrate();
  }, []);
  const fontSans = useWorkspaceStore((s) => s.workspace.fontSans);
  const fontMono = useWorkspaceStore((s) => s.workspace.fontMono);
  const fonts = {
    "--user-font-sans": fontSans,
    "--user-font-mono": fontMono,
  } as CSSProperties;
  return (
    <html lang="zh-CN" style={fonts} suppressHydrationWarning>
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
            跳转到内容
          </a>
          <LiveChat />
          <Outlet />
        </AppProviders>
        <Scripts />
      </body>
    </html>
  );
}
