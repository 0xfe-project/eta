/**
 * Codex (ChatGPT) with OpenAI's device authorization, through `@cpajs/codex-auth`: CPA's
 * management API runs this protocol only in its CLI (the user code goes to stdout). The
 * credential is handed to CPA as a regular codex credential file, which CPA refreshes from then
 * on. What is eta's here is the session the UI polls, the codes its failures are, and the usage.
 */
import type { LlmLogin } from "@eta/client-contracts";
import type { Connector, ConnectorContext, Usage } from "./connectors";
import type { Connection } from "./state";
import {
  CodexAbortError,
  CodexDeviceTimeoutError,
  CodexHttpError,
  completeDeviceAuth,
  startDeviceAuth,
} from "@cpajs/codex-auth";
import { uploadToCpa } from "@cpajs/codex-auth/cpa";
import {
  clampPercent,
  getWithToken,
  Logins,
  randomId,
  windowKind,
} from "./connectors";
import { LlmError } from "./problems";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export class Codex implements Connector {
  readonly info = {
    id: "codex",
    name: "Codex",
    flow: "oauth_device",
  } as const;
  readonly provider = "codex";
  readonly #context: ConnectorContext;
  /** OpenAI's login server; tests point it at a fake. */
  readonly #issuer: string | undefined;
  readonly #logins = new Logins();
  readonly #aborts = new Map<string, AbortController>();

  constructor(context: ConnectorContext, issuer?: string) {
    this.#context = context;
    this.#issuer = issuer;
  }

  async start(): Promise<LlmLogin> {
    let code;
    try {
      code = await startDeviceAuth(this.#options());
    } catch (error) {
      throw new LlmError(
        "login_start_failed",
        "Could not start the Codex login.",
        { provider: "Codex" },
        error,
      );
    }
    const login = this.#logins.add({
      id: randomId("codex"),
      connector: "codex",
      flow: "oauth_device",
      status: "pending",
      url: code.verificationUrl,
      userCode: code.userCode,
      expiresAt: code.expiresAt,
    });
    const abort = new AbortController();
    this.#aborts.set(login.id, abort);
    void this.#complete(login.id, code, abort.signal).finally(() =>
      this.#aborts.delete(login.id),
    );
    return login;
  }

  /** Poll until the user approves, then exchange the code for tokens and hand them to CPA. */
  async #complete(
    id: string,
    code: Awaited<ReturnType<typeof startDeviceAuth>>,
    signal: AbortSignal,
  ): Promise<void> {
    let tokens;
    try {
      tokens = await completeDeviceAuth(code, this.#options(signal));
    } catch (error) {
      // Cancelled: the session is gone already.
      if (error instanceof CodexAbortError) return;
      if (error instanceof CodexDeviceTimeoutError) {
        this.#logins.finish(
          id,
          "expired",
          new LlmError("device_code_timeout", "The device code expired."),
        );
        return;
      }
      // The provider ended the login before it was approved; anything later is the exchange.
      if (error instanceof CodexHttpError && error.step === "devicetoken") {
        this.#context.warn(
          `[eta] llm: the Codex device login failed (HTTP ${error.status})`,
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
      this.#saveFailed(id, error);
      return;
    }
    try {
      await uploadToCpa(this.#context.cpa(), tokens, { signal });
    } catch (error) {
      this.#saveFailed(id, error);
      return;
    }
    this.#logins.finish(id, "succeeded");
  }

  #saveFailed(id: string, error: unknown): void {
    this.#context.warn(`[eta] llm: the Codex login failed: ${String(error)}`);
    this.#logins.finish(
      id,
      "failed",
      new LlmError(
        "login_save_failed",
        "The login succeeded but the credential could not be saved.",
      ),
    );
  }

  #options(signal?: AbortSignal) {
    return {
      ...(this.#issuer === undefined ? {} : { issuer: this.#issuer }),
      ...(signal === undefined ? {} : { signal }),
    };
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
}

interface CodexWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
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
