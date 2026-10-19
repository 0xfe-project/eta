/**
 * Where GitHub sends the browser back to. They live apart from the service so `access.ts` can
 * name the exact paths it lets past the token gate without loading the service.
 */
export const GITHUB_MANIFEST_CALLBACK_PATH = "/github/manifest/callback";
export const GITHUB_AUTHORIZATION_CALLBACK_PATH =
  "/github/authorization/callback";
/** The App's webhook URL: GitHub wants one, and nothing listens (the webhook is inactive). */
export const GITHUB_WEBHOOK_PATH = "/github/webhook";
