import process from "node:process";

/**
 * What the browser's SDK needs (lib/report.ts), as a <meta> for the SPA
 * shell (server.js in production, vite.config.ts in development), or ""
 * without SENTRY_DSN. The browser sends to the public gateway's /sentry,
 * which passes envelopes on to the DSN's server, so it needs only the DSN's
 * key and project.
 */
export function browserSentryMeta(
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!env.SENTRY_DSN) return "";
  const dsn = new URL(env.SENTRY_DSN);
  const config = {
    key: dsn.username,
    project: dsn.pathname.split("/").pop(),
    release: env.SENTRY_RELEASE || env.AXP_VERSION,
    environment: env.SENTRY_ENVIRONMENT,
  };
  const content = JSON.stringify(config)
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;");
  return `<meta name="axp-sentry" content='${content}' />`;
}
