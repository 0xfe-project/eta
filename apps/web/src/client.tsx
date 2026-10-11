import { StartClient } from "@tanstack/react-start/client";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { installErrorReporting } from "@/lib/report";
import { watchForUpdates } from "@/lib/update";

async function start() {
  installErrorReporting();
  watchForUpdates();

  // Makes the app installable from the browser's own install UI.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js");
  }

  // Install the inspector before the first React commit, only in development.
  if (import.meta.env.DEV) {
    await import("react-grab");
  }

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
