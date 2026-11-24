/**
 * Sign in to a Cursor account from the host, for the servers behind `api.cursor.com` that want a
 * Cursor credential in a header (`x-cursor-auth`) rather than the OAuth token of the service
 * they front.
 *
 * UNOFFICIAL. Cursor documents none of this: the shape (a browser page the user confirms, and a
 * poll that answers 404 until then) is what third-party tools report, and it can change or stop
 * working at any time. A failure is shown with its real cause and is never hidden.
 *
 * Only the user's click starts it; nothing refreshes it in the background. Only two hosts are
 * ever asked, over https, and a redirect is a failure. The verifier and the token live in this
 * object's memory and in the saved header: no message, log or error text has either.
 */
import { Buffer } from "node:buffer";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CURSOR_AUTH_HEADER, isCursorServer } from "@eta/client-contracts";

export { CURSOR_AUTH_HEADER, isCursorServer };

const CURSOR_LOGIN_PAGE = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const ALLOWED_HOSTS = new Set(["cursor.com", "api2.cursor.sh"]);
/** The most the user is given to confirm in the browser. */
const CURSOR_LOGIN_TIMEOUT_MS = 120_000;
const POLL_EVERY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY = 64 * 1024;
const MAX_TOKEN = 8 * 1024;
/** How long a finished login can still be asked about. */
const KEEP_MS = 10 * 60_000;

type CursorLoginState = "waiting" | "done" | "failed" | "cancelled" | "expired";

export interface CursorLoginStatus {
  state: CursorLoginState;
  /** Why it failed, in words; never a URL, verifier or token. */
  reason?: string;
  /** Seconds the token claims to be valid for (its `exp`, read and not verified); only when done. */
  validForSeconds?: number;
}

interface Login {
  id: string;
  status: CursorLoginStatus;
  abort: { stopped: boolean; wake: () => void };
  finished?: number;
}

export interface CursorLoginOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollEveryMs?: number;
  /** Receives the token when the user has confirmed; may throw (then the login failed). */
  now?: () => number;
}

/** A host that may be asked: https and one of the two Cursor hosts, nothing else. */
export function cursorLoginAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.port === "" &&
      parsed.username === "" &&
      ALLOWED_HOSTS.has(parsed.hostname)
    );
  } catch {
    return false;
  }
}

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** The `exp` of a JWT in seconds from now, read without checking the signature; undefined if absent. */
export function jwtValidFor(token: string, nowMs: number): number | undefined {
  const part = token.split(".")[1];
  if (part === undefined) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(
        part.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { exp?: unknown };
    return typeof payload.exp === "number"
      ? Math.max(0, Math.floor(payload.exp - nowMs / 1000))
      : undefined;
  } catch {
    return undefined;
  }
}

export class CursorLogin {
  readonly #fetch: typeof fetch;
  readonly #timeout: number;
  readonly #every: number;
  readonly #now: () => number;
  #current: Login | undefined;
  readonly #finishedLogins = new Map<string, Login>();

  constructor(options: CursorLoginOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeout = options.timeoutMs ?? CURSOR_LOGIN_TIMEOUT_MS;
    this.#every = options.pollEveryMs ?? POLL_EVERY_MS;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Begin one login: returns the page the user opens. `onToken` runs once with the token when the
   * user confirmed; if it throws the login failed with its message (it must not contain the token).
   */
  start(onToken: (token: string) => void): { id: string; url: string } {
    if (this.#current?.status.state === "waiting")
      throw new Error("a Cursor sign-in is already waiting for the browser");
    const uuid = randomUUID();
    const verifier = b64url(randomBytes(64));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const url = `${CURSOR_LOGIN_PAGE}?${new URLSearchParams({
      challenge,
      uuid,
      mode: "login",
      redirectTarget: "cli",
    })}`;
    const login: Login = {
      id: randomUUID(),
      status: { state: "waiting" },
      abort: { stopped: false, wake: () => {} },
    };
    this.#current = login;
    this.#finishedLogins.set(login.id, login);
    void this.#run(login, uuid, verifier, onToken);
    return { id: login.id, url };
  }

  status(id: string): CursorLoginStatus {
    const login = this.#finishedLogins.get(id);
    if (login === undefined)
      return { state: "expired", reason: "unknown sign-in" };
    return { ...login.status };
  }

  cancel(id: string): void {
    const login = this.#finishedLogins.get(id);
    if (login === undefined || login.status.state !== "waiting") return;
    login.abort.stopped = true;
    login.status = { state: "cancelled" };
    login.finished = this.#now();
    login.abort.wake();
  }

  #finish(login: Login, status: CursorLoginStatus): void {
    if (login.status.state !== "waiting") return;
    login.status = status;
    login.finished = this.#now();
    for (const [id, one] of this.#finishedLogins)
      if (one.finished !== undefined && this.#now() - one.finished > KEEP_MS)
        this.#finishedLogins.delete(id);
  }

  async #run(
    login: Login,
    uuid: string,
    verifier: string,
    onToken: (token: string) => void,
  ): Promise<void> {
    const deadline = this.#now() + this.#timeout;
    const pollUrl = `${CURSOR_POLL_URL}?${new URLSearchParams({ uuid, verifier })}`;
    if (!cursorLoginAllowed(pollUrl))
      return this.#finish(login, {
        state: "failed",
        reason: "address not allowed",
      });
    while (!login.abort.stopped) {
      if (this.#now() >= deadline)
        return this.#finish(login, {
          state: "expired",
          reason: "the browser did not confirm in time",
        });
      try {
        const response = await this.#fetch(pollUrl, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (login.abort.stopped) return;
        if (response.status >= 300 && response.status < 400)
          return this.#finish(login, {
            state: "failed",
            reason: `Cursor answered with a redirect (HTTP ${response.status}), which is not followed`,
          });
        if (response.status === 404) {
          // Not confirmed yet.
        } else if (response.status === 200) {
          const text = (await response.text()).slice(0, MAX_BODY);
          let token: unknown;
          try {
            token = (JSON.parse(text) as { accessToken?: unknown }).accessToken;
          } catch {
            return this.#finish(login, {
              state: "failed",
              reason: "Cursor answered 200 with something that is not JSON",
            });
          }
          if (
            typeof token !== "string" ||
            token === "" ||
            token.length > MAX_TOKEN ||
            !/^[\w.~+/=-]+$/.test(token)
          )
            return this.#finish(login, {
              state: "failed",
              reason: "Cursor answered 200 without a usable accessToken",
            });
          try {
            onToken(token);
          } catch (error) {
            return this.#finish(login, {
              state: "failed",
              reason: `the token could not be saved: ${error instanceof Error ? error.message : "error"}`,
            });
          }
          const validForSeconds = jwtValidFor(token, this.#now());
          return this.#finish(login, {
            state: "done",
            ...(validForSeconds === undefined ? {} : { validForSeconds }),
          });
        } else {
          return this.#finish(login, {
            state: "failed",
            reason: `Cursor answered HTTP ${response.status}`,
          });
        }
      } catch (error) {
        if (login.abort.stopped) return;
        // The error's own text can carry the address (and with it the verifier): name its kind only.
        return this.#finish(login, {
          state: "failed",
          reason: `could not reach api2.cursor.sh (${error instanceof Error ? error.name : "error"})`,
        });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#every);
        login.abort.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}
