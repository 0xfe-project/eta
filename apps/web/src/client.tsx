import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

async function start() {
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
