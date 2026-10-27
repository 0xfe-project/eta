/**
 * What the gateway makes of CPA's reports: an account's state from its status and cooldowns, a
 * model's from the account's and its own; the agents' keys; the Codex credential file.
 */
import type { AuthFileEntry, CooldownView } from "@cpajs/cpa/client";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { codexCredential, codexPlanName } from "../src/llm/codex";
import { AgentKeys } from "../src/llm/keys";
import {
  connectionReason,
  fileConnection,
  keyConnection,
  modelState,
} from "../src/llm/state";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const later = new Date(NOW + 60_000).toISOString();
const earlier = new Date(NOW - 60_000).toISOString();

function entry(overrides: Partial<AuthFileEntry> = {}): AuthFileEntry {
  return {
    id: "codex-a.json",
    auth_index: "idx1",
    name: "codex-a.json",
    type: "codex",
    provider: "codex",
    label: "",
    status: "active",
    status_message: "",
    disabled: false,
    unavailable: false,
    runtime_only: false,
    source: "file",
    size: 1,
    success: 0,
    failed: 0,
    recent_requests: [],
    quota: { signals: {} },
    cooldowns: null,
    email: "ada@example.com",
    created_at: "2026-10-01T00:00:00Z",
    id_token: { plan_type: "plus", chatgpt_account_id: "acct" },
    ...overrides,
  };
}

const cooldown = (overrides: Partial<CooldownView>): CooldownView => ({
  scope: "credential",
  reason: "unknown",
  retry_at: later,
  remaining_seconds: 60,
  ...overrides,
});

describe("an account's state", () => {
  it("is active, with its label, plan and account id", () => {
    const connection = fileConnection(entry(), "codex", NOW);
    expect(connection).toMatchObject({
      id: "idx1",
      state: "active",
      label: "ada@example.com",
      plan: "plus",
      createdAt: "2026-10-01T00:00:00.000Z",
      source: { kind: "file", name: "codex-a.json", accountId: "acct" },
    });
  });

  it("follows CPA's credential-wide cooldowns, and only those", () => {
    const state = (cooldowns: CooldownView[], overrides = {}) =>
      fileConnection(entry({ cooldowns, ...overrides }), "codex", NOW);
    expect(state([cooldown({ reason: "credential_quota" })])).toMatchObject({
      state: "rate_limited",
      retryAt: later,
      error: { code: "quota_exhausted" },
    });
    expect(
      state([cooldown({ reason: "quota", http_status: 429 })]),
    ).toMatchObject({
      state: "rate_limited",
      error: { code: "rate_limited" },
    });
    expect(
      state([cooldown({ reason: "payment_required", http_status: 402 })]),
    ).toMatchObject({
      state: "error",
      error: { code: "upstream_error", params: { status: 402 } },
    });
    expect(
      state([cooldown({ reason: "transient_error", http_status: 503 })]),
    ).toMatchObject({
      state: "degraded",
      error: { code: "upstream_unstable", params: { status: 503 } },
    });
    expect(state([cooldown({ reason: "unknown" })])).toMatchObject({
      state: "degraded",
      error: { code: "upstream_unreachable" },
    });
    // One model's trouble is that model's; an ended cooldown is nothing.
    expect(
      state([
        cooldown({ scope: "model", model_key: "gpt-x", reason: "quota" }),
        cooldown({ reason: "transient_error", retry_at: earlier }),
      ]).state,
    ).toBe("active");
  });

  it("needs a login when the provider rejects it, from any model", () => {
    expect(
      fileConnection(
        entry({
          cooldowns: [
            cooldown({
              scope: "model",
              model_key: "m",
              reason: "unauthorized",
            }),
          ],
        }),
        "codex",
        NOW,
      ),
    ).toMatchObject({ state: "needs_login", error: { code: "login_expired" } });
    expect(
      fileConnection(
        entry({ status: "error", status_message: "refresh token revoked" }),
        "codex",
        NOW,
      ).state,
    ).toBe("needs_login");
    // A stale error with nothing about the login is not.
    expect(
      fileConnection(
        entry({ status: "error", status_message: "upstream 500" }),
        "codex",
        NOW,
      ).state,
    ).toBe("active");
  });

  it("is disabled before anything else", () => {
    expect(
      fileConnection(
        entry({
          disabled: true,
          cooldowns: [cooldown({ reason: "unauthorized" })],
        }),
        "codex",
        NOW,
      ).state,
    ).toBe("disabled");
  });

  it("is an API key's last four characters, disabled when it excludes every model", () => {
    const key = keyConnection({
      authIndex: "k1",
      connector: "gemini",
      provider: "gemini",
      key: "AIzaSECRET1234",
      disabled: true,
      createdAt: "2026-10-26T00:00:00.000Z",
    });
    expect(key).toMatchObject({ label: "…1234", state: "disabled" });
    expect(JSON.stringify(key.label)).not.toContain("SECRET");
  });
});

describe("a model's state", () => {
  const active = (cooldowns: CooldownView[]) =>
    fileConnection(entry({ cooldowns }), "codex", NOW);

  it("is the model's own cooldown on an active account", () => {
    const of = (reason: string, http_status?: number) =>
      modelState(
        active([
          cooldown({
            scope: "model",
            model_key: "gpt-x",
            reason,
            ...(http_status === undefined ? {} : { http_status }),
          }),
        ]),
        "gpt-x",
        "Codex",
        false,
      );
    expect(of("quota")).toMatchObject({
      status: "unavailable",
      reason: { code: "model_quota_exhausted", params: { provider: "Codex" } },
      retryAt: later,
    });
    expect(of("payment_required", 403).reason).toMatchObject({
      code: "model_forbidden",
      params: { provider: "Codex", status: 403 },
    });
    expect(of("not_found").reason?.code).toBe("model_not_found");
    expect(of("transient_error", 502)).toMatchObject({
      status: "degraded",
      reason: { code: "upstream_unstable" },
    });
    expect(modelState(active([]), "gpt-x", "Codex", false).status).toBe(
      "available",
    );
  });

  it("is the account's when the account is down", () => {
    const limited = active([cooldown({ reason: "credential_quota" })]);
    expect(modelState(limited, "gpt-x", "Codex", false)).toMatchObject({
      status: "unavailable",
      reason: { code: "quota_exhausted", params: { provider: "Codex" } },
    });
    expect(connectionReason("Google AI Studio", true, undefined)).toMatchObject(
      {
        code: "no_connection",
        params: { provider: "Google AI Studio" },
      },
    );
  });
});

describe("agent keys", () => {
  it("are derived, checked and revoked", () => {
    const keys = new AgentKeys();
    const ada = keys.of("ada");
    expect(ada).toMatch(/^etak\.ada\.[0-9a-f]{64}$/);
    expect(keys.of("ada")).toBe(ada);
    expect(keys.scopeOf(ada)).toBe("ada");
    expect(
      keys.scopeOf(`${ada.slice(0, -1)}${ada.endsWith("0") ? "1" : "0"}`),
    ).toBeUndefined();
    expect(keys.scopeOf(new AgentKeys().of("ada"))).toBeUndefined();
    expect(keys.scopeOf("etak.a.b.c")).toBeUndefined();
    expect(() => keys.of("a.b")).toThrow();
    keys.revoke("ada");
    expect(keys.scopeOf(ada)).toBeUndefined();
    expect(keys.scopeOf(keys.of("bo"))).toBe("bo");
  });
});

describe("a Codex login", () => {
  const jwt = (claims: unknown) =>
    `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

  it("becomes a credential file in CPA's codex format", () => {
    const { name, content } = codexCredential(
      jwt({
        email: "ada@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
          chatgpt_plan_type: "Plus",
        },
      }),
      "access",
      "refresh",
      3600,
      new Date("2026-10-26T12:00:00.123Z"),
    );
    expect(name).toMatch(/^codex-[0-9a-f]{8}-ada@example\.com-plus\.json$/);
    expect(content).toEqual({
      type: "codex",
      id_token: expect.any(String),
      access_token: "access",
      refresh_token: "refresh",
      account_id: "acct-1",
      email: "ada@example.com",
      expired: "2026-10-26T13:00:00Z",
      last_refresh: "2026-10-26T12:00:00Z",
    });
    expect(() => codexCredential(jwt({}), "a", "r", 1, new Date())).toThrow();
  });

  it("names plans as ChatGPT does", () => {
    expect(codexPlanName("prolite")).toBe("Pro 5x");
    expect(codexPlanName("pro")).toBe("Pro 20x");
    expect(codexPlanName("team_plus")).toBe("Team Plus");
    expect(codexPlanName("")).toBe("");
  });
});
