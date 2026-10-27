/**
 * Connectors: the ways credentials come into CPA. Codex and Grok log in with a device code,
 * Google AI Studio takes an API key. Whatever the way, the credential ends up in CPA (a
 * credential file, or a key in its config), and listing, disabling and removing it is the
 * gateway's (`gateway.ts`), the same for every connector.
 */
import type { CpaClient } from "@cpajs/cpa/client";
import type {
  LlmConnector,
  LlmLogin,
  LlmQuotaWindow,
} from "@eta/client-contracts";
import type { Connection } from "./state";
import { randomBytes } from "node:crypto";
import { CpaCredentialTokenError, CpaUpstreamError } from "@cpajs/cpa/client";
import { LlmError, notFound } from "./problems";

/** What a provider reports about one account's subscription. */
export interface Usage {
  plan?: string | undefined;
  windows: LlmQuotaWindow[];
}

export interface Connector {
  readonly info: LlmConnector;
  /** CPA's provider key: of its credential files, and under `api-keys` in its config. */
  readonly provider: string;
  start: () => Promise<LlmLogin>;
  poll: (id: string) => Promise<LlmLogin>;
  submit: (id: string, apiKey: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /**
   * Read the account's subscription windows from its provider: a request with the account's
   * token that costs no quota, so it doubles as the account's health check. Throws an
   * `LlmError` (`login_expired` or `invalid_api_key` when the provider rejects the credential).
   */
  usage?: (connection: Connection, signal: AbortSignal) => Promise<Usage>;
}

/** What a connector needs of the gateway. */
export interface ConnectorContext {
  /** CPA's management API; it follows CPA across restarts. */
  cpa: CpaClient;
  warn: (message: string) => void;
}

export const randomId = (prefix: string): string =>
  `${prefix}-${randomBytes(12).toString("hex")}`;

/** The login attempts of one connector. */
export class Logins {
  readonly #sessions = new Map<string, LlmLogin>();

  add(login: LlmLogin): LlmLogin {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (now > Date.parse(session.expiresAt) + 3_600_000)
        this.#sessions.delete(id);
    }
    this.#sessions.set(login.id, login);
    return { ...login };
  }

  get(id: string): LlmLogin {
    const login = this.#sessions.get(id);
    if (login === undefined) throw notFound();
    return { ...login };
  }

  /** End a pending login; an ended one stays as it ended. */
  finish(
    id: string,
    status: LlmLogin["status"],
    error?: LlmError | undefined,
  ): void {
    const login = this.#sessions.get(id);
    if (login === undefined || login.status !== "pending") return;
    login.status = status;
    if (error !== undefined) login.error = error.view;
  }

  delete(id: string): LlmLogin {
    const login = this.get(id);
    this.#sessions.delete(id);
    return login;
  }
}

const noToken = (): LlmError =>
  new LlmError("no_token", "The account has no usable token.");

const unreadable = (cause: unknown): LlmError =>
  new LlmError("usage_unavailable", "Could not read the usage.", {}, cause);

/**
 * GET a provider's JSON with an account's token, which CPA puts in for `$TOKEN$`: the token
 * never leaves CPA. A 401 is the provider rejecting the login.
 */
export async function getWithToken<T extends object>(
  cpa: CpaClient,
  authIndex: string,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<T> {
  let data: unknown;
  try {
    ({ data } = await cpa.requests.apiCallJson(
      {
        auth_index: authIndex,
        method: "GET",
        url,
        header: {
          Authorization: "Bearer $TOKEN$",
          Accept: "application/json",
          ...headers,
        },
      },
      { signal },
    ));
  } catch (error) {
    if (error instanceof CpaCredentialTokenError) throw noToken();
    if (error instanceof CpaUpstreamError && error.status === 401) {
      throw new LlmError(
        "login_expired",
        "The login was rejected (HTTP 401) reading the usage.",
      );
    }
    throw unreadable(error);
  }
  // A body that is not JSON comes back as its text.
  if (typeof data !== "object" || data === null)
    throw unreadable("usage: not a JSON object");
  return data as T;
}

/** Names a window by its length. */
export function windowKind(
  seconds: number,
  fallback: LlmQuotaWindow["kind"],
): LlmQuotaWindow["kind"] {
  if (seconds <= 0) return fallback;
  if (seconds <= 6 * 3600) return "5h";
  if (seconds >= 27 * 24 * 3600) return "monthly";
  return "weekly";
}

export const clampPercent = (value: number): number =>
  Math.min(Math.max(value, 0), 100);

/** Whether a key's `excluded-models` exclude everything: how CPA disables a config key. */
export const excludesAll = (patterns: readonly string[] | null | undefined) =>
  (patterns ?? []).some((pattern) => pattern.trim() === "*");
