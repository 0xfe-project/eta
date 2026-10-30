/**
 * Google AI Studio takes an API key. CPA serves it as a key under `api-keys.gemini` in its
 * config, with its built-in Gemini models; the config is where the key is kept.
 */
import type { LlmLogin } from "@eta/client-contracts";
import type { Connector, ConnectorContext, Usage } from "./connectors";
import type { Connection } from "./state";
import { Logins, randomId, readKeys, updateKeys } from "./connectors";
import { LlmError } from "./problems";

const API = "https://generativelanguage.googleapis.com";
const ENTRY_TIMEOUT_MS = 30 * 60_000;
const PROVIDER = { provider: "Google AI Studio" };

const timedOut = () =>
  new LlmError("login_timeout", "The API key entry timed out.");

export class Gemini implements Connector {
  readonly info = {
    id: "gemini",
    name: "Google AI Studio",
    flow: "api_key",
  } as const;
  readonly provider = "gemini";
  readonly #context: ConnectorContext;
  readonly #api: string;
  readonly #logins = new Logins();

  constructor(context: ConnectorContext, api?: string) {
    this.#context = context;
    this.#api = (api ?? API).replace(/\/$/, "");
  }

  /** A session for `submit` to take the key into. */
  async start(): Promise<LlmLogin> {
    return this.#logins.add({
      id: randomId("gemini"),
      connector: "gemini",
      flow: "api_key",
      status: "pending",
      expiresAt: new Date(Date.now() + ENTRY_TIMEOUT_MS).toISOString(),
    });
  }

  async poll(id: string): Promise<LlmLogin> {
    const login = this.#logins.get(id);
    if (
      login.status === "pending" &&
      Date.now() > Date.parse(login.expiresAt)
    ) {
      this.#logins.finish(id, "expired", timedOut());
      return this.#logins.get(id);
    }
    return login;
  }

  /** Check the key with Google, then add it. A rejected key leaves the session pending to be corrected. */
  async submit(id: string, apiKey: string): Promise<void> {
    if ((await this.poll(id)).status !== "pending") throw timedOut();
    const key = apiKey.trim();
    if (key === "")
      throw new LlmError("api_key_required", "The API key is empty.");
    const cpa = this.#context.cpa();
    const duplicate = () =>
      new LlmError("duplicate_api_key", "This API key was added before.");
    const has = (groups: { keys: { "api-key": string }[] }[] | undefined) =>
      (groups ?? []).some((group) =>
        group.keys.some((entry) => entry["api-key"] === key),
      );
    if (has((await readKeys(cpa, "gemini")).groups)) throw duplicate();
    try {
      await this.#verify(key, AbortSignal.timeout(30_000));
    } catch (error) {
      if (error instanceof LlmError && error.code === "invalid_api_key")
        throw new LlmError(
          "invalid_api_key",
          "The API key is invalid.",
          undefined,
          error,
        );
      throw new LlmError(
        "key_check_unavailable",
        "Google AI Studio could not be reached to check the API key.",
        PROVIDER,
        error,
      );
    }
    await updateKeys(cpa, "gemini", (groups) => {
      if (has(groups)) throw duplicate();
      // The keys of the default endpoint are one group; a group with a base URL is someone else's.
      const index = groups.findIndex(
        (group) => (group["base-url"] ?? "") === "",
      );
      if (index === -1) return [...groups, { keys: [{ "api-key": key }] }];
      return groups.map((group, i) =>
        i === index
          ? { ...group, keys: [...group.keys, { "api-key": key }] }
          : group,
      );
    });
    this.#logins.finish(id, "succeeded");
  }

  async cancel(id: string): Promise<void> {
    this.#logins.delete(id);
  }

  /** Google reports no limits for a key, but listing its models costs nothing and fails for a key it rejects. */
  async usage(connection: Connection, signal: AbortSignal): Promise<Usage> {
    if (connection.source.kind !== "key")
      throw new LlmError("no_token", "The account has no usable token.");
    await this.#verify(connection.source.key, signal);
    return { windows: [] };
  }

  /**
   * List the models the key may use. Google answers a key it does not accept with 400
   * API_KEY_INVALID, or 401/403 (revoked, leaked, API not enabled for its project).
   */
  async #verify(key: string, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#api}/v1beta/models?pageSize=1`, {
        headers: { "x-goog-api-key": key },
        signal,
      });
    } catch (error) {
      throw new LlmError(
        "usage_unavailable",
        "Google AI Studio could not be reached.",
        undefined,
        error,
      );
    }
    if (response.ok) return;
    const body = await response.text().catch(() => "");
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status === 400 && body.includes("API_KEY_INVALID"))
    ) {
      throw new LlmError(
        "invalid_api_key",
        "Google AI Studio rejected the API key.",
      );
    }
    throw new LlmError(
      "usage_unavailable",
      "Google AI Studio could not be reached.",
      undefined,
      `gemini models: status ${response.status}`,
    );
  }
}
