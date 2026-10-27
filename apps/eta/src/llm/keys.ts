/**
 * Who may use the gateway's `/v1`: the agents' own keys.
 *
 * An agent's key is `etak.<agent id>.<HMAC-SHA256(host key, "eta-llm-scope:" + id)>`. It is
 * derived, not stored: the host makes one without a table and checks it the same way. The host
 * key is random per process, so a restart ends every agent key; `revoke` ends one agent's keys
 * until then. CPA itself only knows the host's internal key, which never leaves this process:
 * a request with an agent's key is checked here and forwarded with that one.
 */
import { Buffer } from "node:buffer";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** What a scope (an agent id) may be: no dots, so a key splits unambiguously. */
const SCOPE = /^[\w-]{1,64}$/;

const PREFIX = "etak.";

export class AgentKeys {
  readonly #hostKey = randomBytes(32).toString("hex");
  readonly #revoked = new Set<string>();

  #mac(scope: string): string {
    return createHmac("sha256", this.#hostKey)
      .update(`eta-llm-scope:${scope}`)
      .digest("hex");
  }

  /** The key of one agent. Throws for an id that is not a plain id. */
  of(scope: string): string {
    if (!SCOPE.test(scope)) throw new Error(`not a key scope: ${scope}`);
    return `${PREFIX}${scope}.${this.#mac(scope)}`;
  }

  /** End every key of an agent, until the host restarts (which ends them all). */
  revoke(scope: string): void {
    this.#revoked.add(scope);
  }

  /** The agent a bearer value is the key of, or undefined. */
  scopeOf(bearer: string): string | undefined {
    if (!bearer.startsWith(PREFIX)) return undefined;
    const parts = bearer.split(".");
    if (parts.length !== 3) return undefined;
    const [, scope, mac] = parts as [string, string, string];
    if (!SCOPE.test(scope) || this.#revoked.has(scope)) return undefined;
    const want = Buffer.from(this.#mac(scope));
    const got = Buffer.from(mac);
    return got.length === want.length && timingSafeEqual(got, want)
      ? scope
      : undefined;
  }
}
