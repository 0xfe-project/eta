/**
 * Error tracking in the browser with the Sentry SDK: uncaught errors,
 * unhandled rejections and React's render errors (main.tsx hands
 * reactErrorHandler to the root). The web server puts the settings in the
 * SPA shell (server/telemetry.ts) when it has a DSN; without them nothing is
 * sent. Events go to the public gateway's /sentry, which passes them on to
 * Rustrak; production builds carry debug ids, so Rustrak maps stacks back to
 * the source with the uploaded source maps.
 */
import * as Sentry from "@sentry/react";
import { isNotFound, isRedirect } from "@tanstack/react-router";

interface Settings {
  key: string;
  project: string;
  release?: string;
  environment?: string;
}

function settings(): Settings | undefined {
  const content = document
    .querySelector<HTMLMetaElement>('meta[name="axp-sentry"]')
    ?.getAttribute("content");
  if (!content) return undefined;
  try {
    return JSON.parse(content) as Settings;
  } catch {
    return undefined;
  }
}

export function installErrorReporting() {
  const s = settings();
  if (!s) return;
  Sentry.init({
    dsn: `${location.protocol}//${s.key}@${location.host}/sentry/${s.project}`,
    release: s.release,
    environment: s.environment,
  });
}

const capture = Sentry.reactErrorHandler((error) => console.error(error));

/**
 * For createRoot's onUncaughtError, onCaughtError and onRecoverableError;
 * the router's own not-found and redirect throws are not errors.
 */
export const reportReactError: typeof capture = (error, info) => {
  if (isNotFound(error) || isRedirect(error)) return;
  capture(error, info);
};
