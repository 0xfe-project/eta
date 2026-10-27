/**
 * xAI (Grok) with the device-code flow CPA's management API runs: `oauth/auth-url` starts it,
 * `oauth/status` reports completion, and CPA stores the credential itself.
 */
import type { LlmLogin } from "@eta/client-contracts";
import type { Connector, ConnectorContext, Usage } from "./connectors";
import type { Connection } from "./state";
import { clampPercent, getWithToken, Logins, windowKind } from "./connectors";
import { LlmError } from "./problems";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";

export class XAI implements Connector {
  readonly info = { id: "xai", name: "Grok", flow: "oauth_device" } as const;
  readonly provider = "xai";
  readonly #context: ConnectorContext;
  readonly #logins = new Logins();

  constructor(context: ConnectorContext) {
    this.#context = context;
  }

  async start(): Promise<LlmLogin> {
    let started;
    try {
      started = await this.#context.cpa.oauth.start({ provider: "xai" });
    } catch (error) {
      throw new LlmError(
        "login_start_failed",
        "Could not start the xAI login.",
        { provider: "xAI" },
        error,
      );
    }
    const expiresIn =
      "expires_in" in started && started.expires_in !== undefined
        ? started.expires_in
        : 900;
    return this.#logins.add({
      id: started.state,
      connector: "xai",
      flow: "oauth_device",
      status: "pending",
      url: started.url,
      ...("user_code" in started && started.user_code !== undefined
        ? { userCode: started.user_code }
        : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });
  }

  async poll(id: string): Promise<LlmLogin> {
    const login = this.#logins.get(id);
    if (login.status !== "pending") return login;
    const expired = () =>
      this.#logins.finish(
        id,
        "expired",
        new LlmError("device_code_timeout", "The device code expired."),
      );
    if (Date.now() > Date.parse(login.expiresAt)) {
      expired();
      return this.#logins.get(id);
    }
    const status = await this.#context.cpa.oauth.status(id);
    if (status.status === "ok") this.#logins.finish(id, "succeeded");
    else if (status.status === "error") {
      const error = status.error.toLowerCase();
      if (error.includes("timeout") || error.includes("expired")) expired();
      else
        this.#logins.finish(
          id,
          "failed",
          new LlmError("login_failed", "The login failed."),
        );
    }
    return this.#logins.get(id);
  }

  async submit(): Promise<void> {
    throw new LlmError(
      "unsupported",
      "The connector does not support this operation.",
    );
  }

  async cancel(id: string): Promise<void> {
    const login = this.#logins.delete(id);
    if (login.status === "pending") await this.#context.cpa.oauth.cancel(id);
  }

  /** The credit window of a Grok subscription; accounts billed without a period have none. */
  async usage(connection: Connection, signal: AbortSignal): Promise<Usage> {
    const cpa = this.#context.cpa;
    const billing = await getWithToken<{
      config?: {
        currentPeriod?: { start?: string; end?: string } | null;
        creditUsagePercent?: number | string;
      };
    }>(cpa, connection.authIndex, BILLING_URL, {}, signal);
    // The plan's name is optional.
    const settings = await getWithToken<{
      subscription_tier_display?: string;
    }>(cpa, connection.authIndex, SETTINGS_URL, {}, signal).catch(() => ({
      subscription_tier_display: undefined,
    }));
    const usage: Usage = {
      plan: settings.subscription_tier_display?.trim() ?? "",
      windows: [],
    };
    const period = billing.config?.currentPeriod;
    const start = Date.parse(period?.start ?? "");
    const end = Date.parse(period?.end ?? "");
    if (end > start) {
      const seconds = Math.round((end - start) / 1000);
      usage.windows.push({
        kind: windowKind(seconds, "weekly"),
        used: clampPercent(
          Number(billing.config?.creditUsagePercent ?? 0) || 0,
        ),
        resetsAt: new Date(end).toISOString(),
        durationSeconds: seconds,
      });
    }
    return usage;
  }
}
