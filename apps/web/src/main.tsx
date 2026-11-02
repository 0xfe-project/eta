/* eslint-disable perfectionist/sort-imports -- the hook is imported first,
   so it exists when react-dom loads */
import "@/lib/react-devtools-hook";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { startTransition, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useWorkspaceStore } from "@/components/workspace/workspace-store";
import { savedElementPicker, setElementPicker } from "@/lib/element-picker";
import {
  applyDocumentLanguage,
  i18n,
  readLanguagePreference,
  resolveLanguage,
} from "@/lib/i18n";
import { markHost, watchExternalLinks } from "@/lib/native";
import { applyTheme, readTheme, watchSystemTheme } from "@/lib/theme";
import { watchForUpdates } from "@/lib/update";
import { getWire } from "@/lib/wire";
import { useOutbox } from "@/queries/outbox";
import { getRouter } from "./router";
import "@/styles.css";

async function start() {
  // Where we are: the shell's preload says so, if there is a shell. Before anything paints a
  // window's own chrome, and before a click on a link can mean "leave".
  markHost();
  watchExternalLinks();
  watchForUpdates();
  // The one connection to the host, open before anything asks for data over it.
  getWire();

  // Makes the app installable from the browser's own install UI.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }

  // 圈选元素, installed before the first React commit when turned on.
  if (savedElementPicker()) await setElementPicker(true);

  await Promise.all([
    useWorkspaceStore.persist.rehydrate(),
    useOutbox.persist.rehydrate(),
  ]);
  void i18n.changeLanguage(resolveLanguage(readLanguagePreference()));
  applyDocumentLanguage();
  // index.html painted the mode before the bundle; this is what keeps it true afterwards
  // (a changed choice in another tab, or the system flipping while the tab is open).
  applyTheme(readTheme());
  window.addEventListener("storage", () => applyTheme(readTheme()));
  watchSystemTheme();

  const router = getRouter();
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  // The first page is resolved, its chunk included, before React's first commit. Rendered any
  // earlier, the router commits an empty tree (nothing matched yet) over index.html's outline and
  // the window goes blank until the route's pending outline comes in after defaultPendingMs.
  await router.load().catch(console.error);

  startTransition(() => {
    createRoot(root).render(
      <StrictMode>
        <QueryClientProvider client={router.options.context.queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
}

void start();
