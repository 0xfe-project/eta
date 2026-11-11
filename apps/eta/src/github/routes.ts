/**
 * GitHub sending the browser back: after the App was created (manifest), and after the user
 * authorized it (from the wizard, or right after installing it). The browser arrives from
 * github.com carrying none of our cookies, so these two exact paths are exempt from the token
 * gate (`../access`), for GET only; what makes a request ours is the one-time `state` the host
 * made, which the service checks first and spends. Anything else (no state, an unknown or used
 * one) changes nothing and ends on the settings page with the reason.
 *
 * Each ends in a redirect to Settings → Connections, told what happened; the page reopens the wizard.
 */
import type { Github } from "./service";
import { GithubError, messageOf } from "./error";
import {
  GITHUB_AUTHORIZATION_CALLBACK_PATH,
  GITHUB_MANIFEST_CALLBACK_PATH,
} from "./path";

/** Settings → Connections on the home page, told what happened. */
const back = (key: string, value: string): string =>
  `/?${new URLSearchParams({ settings: "connections", [key]: value }).toString()}`;

const redirect = (location: string): Response =>
  new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

export function githubRoutes(
  github: Github,
  warn: (message: string) => void,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    if (request.method !== "GET") return undefined;
    const url = new URL(request.url);
    const query = url.searchParams;
    if (url.pathname === GITHUB_MANIFEST_CALLBACK_PATH) {
      try {
        await github.finishManifest(
          query.get("code") ?? "",
          query.get("state") ?? "",
        );
        return redirect(back("github", "created"));
      } catch (error) {
        warn(`[eta] creating the GitHub App failed: ${String(error)}`);
        return redirect(back("github_error", messageOf(error)));
      }
    }
    if (url.pathname === GITHUB_AUTHORIZATION_CALLBACK_PATH) {
      const code = query.get("code") ?? "";
      const setupAction = query.get("setup_action") ?? "";
      try {
        if ((query.get("error") ?? "") !== "") {
          // Declined, or GitHub could not ask.
          throw new GithubError(
            "AUTHORIZATION_DECLINED",
            400,
            `Authorization was not completed：${query.get("error_description") ?? ""}`,
          );
        }
        if (code !== "") {
          await github.finishAuthorization(
            code,
            query.get("state") ?? "",
            setupAction,
          );
          return redirect(back("github", "authorized"));
        }
        if (setupAction !== "")
          return redirect(back("setup_action", setupAction));
        throw new GithubError(
          "AUTHORIZATION_EXPIRED",
          400,
          "This authorization has expired，please return to eta to authorize again。",
        );
      } catch (error) {
        warn(`[eta] authorizing the GitHub App failed: ${String(error)}`);
        return redirect(back("github_error", messageOf(error)));
      }
    }
    return undefined;
  };
}
