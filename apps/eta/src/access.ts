import type { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
/**
 * Who may reach the host. Two independent checks, both run by the transport's `authorize`
 * before any route and before the WebSocket upgrade — the pipe runs commands and reads files as
 * this user, so it is the one thing that must never be reachable by accident.
 *
 * **Origin.** A browser attaches the page's origin to a WebSocket handshake and a page cannot
 * forge it, so a handshake from a page that is not ours is a random website trying to drive the
 * host through the user's browser. A handshake with no `Origin` is not a browser (a script, a
 * daemon) and passes this check. A page is ours when its origin is the origin it asked, or one
 * the host was told about (`--allow-origin`: in development the page is served by vite on
 * another port). "The origin it asked" is only trusted when the host is not guessable by a
 * rebound DNS name: an attacker's domain pointed at 127.0.0.1 would otherwise be "its own
 * origin", so on a loopback host without the token gate the name asked for has to be loopback too.
 *
 * **Token gate.** On when a token file is given or the host listens beyond loopback, because
 * then anything that can route to the port can use it. Everything but `/up` needs the token:
 * as `Authorization: Bearer …` (a script), or as a cookie (a browser), which `/?token=…`
 * trades the token for once. The cookie holds a hash of the token, never the token, and is
 * `SameSite=Strict` so another site's request does not carry it. This is the dev gateway of the
 * upstream repository (scripts/dev/gateway.ts) moved into the host.
 */
import {
  DAEMON_DOWNLOAD_PATH,
  ENROLL_PATH,
  INSTALL_DOWNLOAD_PATH,
  INSTALL_SCRIPT_PATH,
  LINK_PATH,
} from "@eta/client-contracts";

import {
  GITHUB_AUTHORIZATION_CALLBACK_PATH,
  GITHUB_MANIFEST_CALLBACK_PATH,
} from "./github/path";
import { LLM_ROUTE } from "./llm/route";

const COOKIE = "eta_session";
/** Thirty days: a browser that was let in once should not be asked again on Monday. */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const MIN_TOKEN_LENGTH = 16;

export interface AccessOptions {
  /** The interface the host listens on: a non-loopback one turns the token gate on. */
  hostname: string;
  dataDir: string;
  /** The token file. Giving one turns the gate on; it is created (0600) when missing. */
  tokenFile?: string | undefined;
  /** Other origins that may open the socket (the dev page's). */
  allowOrigins?: readonly string[] | undefined;
}

export interface Access {
  /** The transport's `authorize`: a `Response` refuses, `undefined` lets the request in. */
  authorize: (request: Request) => Response | undefined;
  /** The token file in use, or `undefined` when the gate is off. */
  readonly tokenFile: string | undefined;
}

/** Whether an interface or `Host` name can only be reached from this machine. */
export function isLoopback(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "::ffff:127.0.0.1" ||
    /^127(?:\.\d{1,3}){3}$/.test(name)
  );
}

/** Read the token, creating the file the first time (it is a secret: 0600, in a 0700 directory). */
function loadToken(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${randomBytes(24).toString("base64url")}\n`, {
      mode: 0o600,
    });
  }
  chmodSync(path, 0o600);
  const token = readFileSync(path, "utf8").trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${path}: the token is shorter than ${MIN_TOKEN_LENGTH}`);
  }
  return token;
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/** Compare the hashes, not the strings: the comparison time then says nothing about the token. */
function matches(candidate: string | null | undefined, expected: Buffer) {
  return (
    candidate !== null &&
    candidate !== undefined &&
    timingSafeEqual(digest(candidate), expected)
  );
}

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** The `Host` a request asked for, as `hostname:port`, and the scheme the browser used for it. */
function askedFor(request: Request): { host: string; origin: string } {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  // A TLS-terminating proxy in front says which scheme the browser saw; a script that lies
  // here only changes which origin it compares itself to.
  const scheme =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    url.protocol.replace(":", "");
  return { host, origin: `${scheme}://${host}` };
}

/**
 * The pages that carry their own capability: an artifact's preview (a signed address, because a
 * sandboxed iframe sends no cookie) and its public share (a secret token, for people who are not
 * the user), and the return of an MCP server's OAuth sign-in (the browser comes back from the
 * provider, a site that holds no cookie of ours; the route completes only a sign-in this host is
 * waiting for, found by its unguessable `state`), and likewise GitHub's two returns to the host
 * (the App was created from the manifest the host made; the user authorized the App), which spend a
 * `state` the host issued and otherwise change nothing. They are exempt from the token gate for
 * that reason and no other, and only to read: everything else, the app's own `/artifacts/` downloads
 * included, stays behind it.
 */
function carriesOwnCapability(request: Request, pathname: string): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    (pathname.startsWith("/preview/") ||
      pathname.startsWith("/share/") ||
      pathname === GITHUB_MANIFEST_CALLBACK_PATH ||
      pathname === GITHUB_AUTHORIZATION_CALLBACK_PATH)
  );
}

/**
 * The routes a machine uses, not a browser: enrolling, the link, fetching the daemon build to
 * replace itself with, and the install script a new machine runs (with the build it fetches). A
 * machine has no cookie and sends no origin, so neither check below can say anything about it.
 * Each route authenticates what it carries (an install code, a device credential), and the host
 * answers for that, not this file.
 */
function isMachineRoute(pathname: string): boolean {
  return (
    pathname === ENROLL_PATH ||
    pathname === LINK_PATH ||
    pathname === INSTALL_SCRIPT_PATH ||
    pathname.startsWith(`${DAEMON_DOWNLOAD_PATH}/`) ||
    pathname.startsWith(`${INSTALL_DOWNLOAD_PATH}/`)
  );
}

/**
 * The gateway route a daemon's sessions use for their bundles' tools. It is not a browser's and
 * carries no cookie, so the token gate cannot say anything about it; the route admits an agent's
 * scoped key and nothing else (see `llm/runtime.ts`).
 */
function isGatewayRoute(pathname: string): boolean {
  return pathname.startsWith(LLM_ROUTE);
}

const refuse = (status: number, message: string): Response =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export function createAccess(options: AccessOptions): Access {
  const allowed = new Set(options.allowOrigins ?? []);
  const gated =
    options.tokenFile !== undefined || !isLoopback(options.hostname);
  const tokenFile = gated
    ? (options.tokenFile ?? join(options.dataDir, "access-token"))
    : undefined;
  const gate =
    tokenFile === undefined
      ? undefined
      : (() => {
          const token = loadToken(tokenFile);
          // What the cookie holds: derived from the token, so a leaked cookie is not the token.
          const cookie = createHash("sha256")
            .update(`eta-cookie:${token}`)
            .digest("base64url");
          return { token: digest(token), cookie, cookieDigest: digest(cookie) };
        })();

  function originAllowed(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (origin === null) return true;
    if (allowed.has(origin)) return true;
    const asked = askedFor(request);
    if (origin !== asked.origin) return false;
    // The origin it asked for. Behind the token gate that is enough (a rebound name has no
    // cookie); without it the name has to be one only this machine can resolve.
    if (gated) return true;
    try {
      return isLoopback(new URL(`http://${asked.host}`).hostname);
    } catch {
      // A Host header that is no host at all.
      return false;
    }
  }

  return {
    tokenFile,
    authorize(request) {
      const url = new URL(request.url);
      if (
        url.pathname === "/up" ||
        isMachineRoute(url.pathname) ||
        isGatewayRoute(url.pathname)
      )
        return undefined;

      if (url.pathname === "/ws" && !originAllowed(request)) {
        return refuse(403, "origin not allowed");
      }
      if (gate === undefined) return undefined;
      if (carriesOwnCapability(request, url.pathname)) return undefined;

      // `/?token=…`: trade the token for the cookie and leave a URL without it behind. A socket
      // cannot follow a redirect, so this is for pages; a socket brings the cookie or a bearer.
      const offered = url.searchParams.get("token");
      if (offered !== null && url.pathname !== "/ws") {
        if (!matches(offered, gate.token)) return refuse(401, "unauthorized");
        url.searchParams.delete("token");
        const secure = askedFor(request).origin.startsWith("https:")
          ? "; Secure"
          : "";
        return new Response(null, {
          status: 303,
          headers: {
            // One leading slash: `//host` would be a redirect to another site.
            location: `/${url.pathname.replace(/^\/+/, "")}${url.search}`,
            "set-cookie": `${COOKIE}=${gate.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${secure}`,
            "cache-control": "no-store",
          },
        });
      }

      const bearer = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "");
      if (
        matches(bearer, gate.token) ||
        matches(cookieOf(request, COOKIE), gate.cookieDigest)
      ) {
        return undefined;
      }
      return refuse(
        401,
        "unauthorized: open /?token=<token> once, or send Authorization: Bearer <token>",
      );
    },
  };
}
