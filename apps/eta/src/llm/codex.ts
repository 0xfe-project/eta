/**
 * Codex (ChatGPT) with OpenAI's device authorization. CPA runs this protocol only in its CLI (the
 * user code goes to stdout), so the steps are repeated here; the credential is handed to CPA as
 * a regular codex credential file.
 */
import type { LlmLogin } from "@eta/client-contracts";
import type { Connector, ConnectorContext, Usage } from "./connectors";
import type { Connection } from "./state";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  clampPercent,
  getWithToken,
  Logins,
  randomId,
  windowKind,
} from "./connectors";
import { LlmError } from "./problems";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const startFailed = (cause: unknown) =>
  new LlmError(
    "login_start_failed",
    "Could not start the Codex login.",
    { provider: "Codex" },
    cause,
  );

export class Codex implements Connector {
  readonly info = {
    id: "codex",
    name: "Codex",
    flow: "oauth_device",
  } as const;
  readonly provider = "codex";
  readonly #context: ConnectorContext;
  readonly #issuer: string;
  readonly #logins = new Logins();
  readonly #aborts = new Map<string, AbortController>();

  constructor(context: ConnectorContext, issuer?: string) {
    this.#context = context;
    this.#issuer = (issuer ?? ISSUER).replace(/\/$/, "");
  }

  async start(): Promise<LlmLogin> {
    let code: {
      device_auth_id?: string;
      user_code?: string;
      usercode?: string;
      interval?: unknown;
    };
    try {
      const response = await this.#post(
        "/api/accounts/deviceauth/usercode",
        { client_id: CODEX_CLIENT_ID },
        AbortSignal.timeout(30_000),
      );
      if (!response.ok) throw new Error(`status ${response.status}`);
      code = (await response.json()) as typeof code;
    } catch (error) {
      throw startFailed(error);
    }
    const userCode = (code.user_code ?? code.usercode ?? "").trim();
    if (userCode === "" || code.device_auth_id === undefined)
      throw startFailed("the device code response is missing fields");
    const login = this.#logins.add({
      id: randomId("codex"),
      connector: "codex",
      flow: "oauth_device",
      status: "pending",
      url: VERIFICATION_URL,
      userCode,
      expiresAt: new Date(Date.now() + DEVICE_TIMEOUT_MS).toISOString(),
    });
    const abort = new AbortController();
    this.#aborts.set(login.id, abort);
    void this.#complete(
      login.id,
      code.device_auth_id,
      userCode,
      pollInterval(code.interval),
      AbortSignal.any([abort.signal, AbortSignal.timeout(DEVICE_TIMEOUT_MS)]),
    ).finally(() => this.#aborts.delete(login.id));
    return login;
  }

  /** Poll until the user approves, then exchange the code for tokens and hand them to CPA. */
  async #complete(
    id: string,
    deviceAuthId: string,
    userCode: string,
    interval: number,
    signal: AbortSignal,
  ): Promise<void> {
    const expired = () =>
      this.#logins.finish(
        id,
        "expired",
        new LlmError("device_code_timeout", "The device code expired."),
      );
    let grant: { authorization_code?: string; code_verifier?: string };
    for (;;) {
      let status: number | undefined;
      try {
        const response = await this.#post(
          "/api/accounts/deviceauth/token",
          { device_auth_id: deviceAuthId, user_code: userCode },
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        status = response.status;
        if (response.ok) {
          grant = (await response.json()) as typeof grant;
          break;
        }
      } catch {
        // A network failure: try again on the next tick.
      }
      if (signal.aborted) return expired();
      // 403 and 404 mean "not approved yet"; anything else is final.
      if (status !== undefined && status !== 403 && status !== 404) {
        this.#context.warn(
          `[eta] llm: the Codex device login failed (HTTP ${status})`,
        );
        this.#logins.finish(
          id,
          "failed",
          new LlmError(
            "login_failed",
            "The provider ended the login with an error.",
          ),
        );
        return;
      }
      await Bun.sleep(interval);
      if (signal.aborted) return expired();
    }
    try {
      await this.#store(
        grant.authorization_code ?? "",
        grant.code_verifier ?? "",
        signal,
      );
    } catch (error) {
      this.#context.warn(`[eta] llm: the Codex login failed: ${String(error)}`);
      this.#logins.finish(
        id,
        "failed",
        new LlmError(
          "login_save_failed",
          "The login succeeded but the credential could not be saved.",
        ),
      );
      return;
    }
    this.#logins.finish(id, "succeeded");
  }

  async #store(
    code: string,
    verifier: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${this.#issuer}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code,
        redirect_uri: DEVICE_REDIRECT_URI,
        code_verifier: verifier,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (response.status !== 200)
      throw new Error(`token exchange: status ${response.status}`);
    const token = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    const { name, content } = codexCredential(
      token.id_token ?? "",
      token.access_token ?? "",
      token.refresh_token ?? "",
      token.expires_in ?? 0,
      new Date(),
    );
    await this.#context.cpa().credentials.upload({ name, content });
  }

  async poll(id: string): Promise<LlmLogin> {
    return this.#logins.get(id);
  }

  async submit(): Promise<void> {
    throw new LlmError(
      "unsupported",
      "The connector does not support this operation.",
    );
  }

  async cancel(id: string): Promise<void> {
    this.#logins.delete(id);
    this.#aborts.get(id)?.abort();
  }

  /** The 5-hour and weekly windows of the ChatGPT subscription. */
  async usage(connection: Connection, signal: AbortSignal): Promise<Usage> {
    const accountId =
      connection.source.kind === "file" ? connection.source.accountId : "";
    const body = await getWithToken<{
      plan_type?: string;
      rate_limit?: {
        primary_window?: CodexWindow | null;
        secondary_window?: CodexWindow | null;
      };
    }>(
      this.#context.cpa(),
      connection.authIndex,
      USAGE_URL,
      accountId === undefined || accountId === ""
        ? {}
        : { "ChatGPT-Account-Id": accountId },
      signal,
    );
    const windows = [
      [body.rate_limit?.primary_window, "5h"],
      [body.rate_limit?.secondary_window, "weekly"],
    ] as const;
    return {
      plan: codexPlanName(body.plan_type ?? ""),
      windows: windows.flatMap(([window, fallback]) =>
        window === undefined || window === null
          ? []
          : [
              {
                kind: windowKind(window.limit_window_seconds ?? 0, fallback),
                used: clampPercent(window.used_percent ?? 0),
                ...(window.limit_window_seconds === undefined
                  ? {}
                  : { durationSeconds: window.limit_window_seconds }),
                ...(window.reset_at === undefined || window.reset_at <= 0
                  ? {}
                  : {
                      resetsAt: new Date(window.reset_at * 1000).toISOString(),
                    }),
              },
            ],
      ),
    };
  }

  #post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.#issuer}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

/** The claims of a JWT, not verified: only for tokens received from the issuer over TLS. */
function claimsOf<T>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as T;
}

/** A credential in CPA's codex file format, and its conventional file name. */
export function codexCredential(
  idToken: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
  now: Date,
): { name: string; content: Record<string, string> } {
  const claims = claimsOf<{
    email?: string;
    "https://api.openai.com/auth"?: {
      chatgpt_account_id?: string;
      chatgpt_plan_type?: string;
    };
  }>(idToken);
  const email = claims.email ?? "";
  const auth = claims["https://api.openai.com/auth"] ?? {};
  if (email === "" || accessToken === "" || refreshToken === "")
    throw new Error("the token response is missing account information");
  const accountId = auth.chatgpt_account_id ?? "";
  let name = "codex";
  if (accountId !== "")
    name += `-${createHash("sha256").update(accountId).digest("hex").slice(0, 8)}`;
  name += `-${email}`;
  const plan = (auth.chatgpt_plan_type ?? "").trim().toLowerCase();
  if (plan !== "") name += `-${plan}`;
  const seconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    name: `${name}.json`,
    content: {
      type: "codex",
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
      email,
      expired: seconds(new Date(now.getTime() + expiresIn * 1000)),
      last_refresh: seconds(now),
    },
  };
}

/** `chatgpt_plan_type` as ChatGPT names it. */
export function codexPlanName(plan: string): string {
  const value = plan.trim().toLowerCase();
  if (value === "") return "";
  if (value === "prolite") return "Pro 5x";
  if (value === "pro") return "Pro 20x";
  return value
    .split("_")
    .map((word) =>
      word === "" ? word : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function pollInterval(raw: unknown): number {
  const seconds =
    typeof raw === "string" ? Number.parseInt(raw.trim(), 10) : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
}
