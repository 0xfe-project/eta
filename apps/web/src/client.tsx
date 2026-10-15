/* eslint-disable perfectionist/sort-imports -- the hook is imported first,
   so it exists when react-dom loads */
import "@/lib/react-devtools-hook";
import { StartClient } from "@tanstack/react-start/client";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { savedElementPicker, setElementPicker } from "@/lib/element-picker";
import { installErrorReporting } from "@/lib/report";
import { watchForUpdates } from "@/lib/update";

async function start() {
  installErrorReporting();
  watchForUpdates();

  // Makes the app installable from the browser's own install UI.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }

  // 圈选元素, installed before the first React commit when turned on.
  if (savedElementPicker()) await setElementPicker(true);

  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
  });
}

void start();
