/**
 * The gateway against the real CLIProxyAPI (a child process), with Google and OpenAI's login
 * faked: a Google AI Studio key is checked, kept in CPA's config, disabled, enabled and removed,
 * and outlives a restart; the Go gateway's `providers.json` moves into the config; a Codex device
 * login ends as a credential file CPA serves.
 */
import type { LlmModel } from "@eta/client-contracts";
import type { LlmRuntime } from "../src/llm/runtime";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayModels } from "../src/llm/models";
import { openLlm } from "../src/llm/runtime";
import { until } from "./support/client";
import { tempDir } from "./support/host";

const GOOD = "AIzaGOODGOODGOOD0001";
const BAD = "AIzaBADBADBADBAD0002";

/** Google's model list: a key it knows lists, any other is invalid. */
function fakeGoogle() {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const key = request.headers.get("x-goog-api-key");
      if (key === GOOD) return Response.json({ models: [] });
      return Response.json(
        {
          error: {
            status: "INVALID_ARGUMENT",
            details: [{ reason: "API_KEY_INVALID" }],
          },
        },
        { status: 400 },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

const jwt = (claims: unknown) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/**
 * OpenAI's device authorization: approved on the second poll, unless `mode` says the login is
 * refused (a final error while polling) or the exchange fails. It keeps what it was sent.
 */
function fakeOpenAI(
  mode: "ok" | "refused" | "exchange-fails" = "ok",
  email = "ada@example.com",
) {
  let polls = 0;
  const sent: { path: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { pathname } = new URL(request.url);
      sent.push({ path: pathname, body: await request.text() });
      if (pathname === "/api/accounts/deviceauth/usercode")
        return Response.json({
          device_auth_id: "dev-1",
          user_code: "ABCD-1234",
          interval: "1",
        });
      if (pathname === "/api/accounts/deviceauth/token") {
        if (mode === "refused")
          return Response.json({ error: "access_denied" }, { status: 400 });
        return ++polls < 2
          ? new Response("pending", { status: 403 })
          : Response.json({
              authorization_code: "code",
              code_verifier: "verifier",
            });
      }
      if (pathname === "/oauth/token") {
        if (mode === "exchange-fails")
          return new Response("nope", { status: 500 });
        return Response.json({
          id_token: jwt({
            email,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-1",
              chatgpt_plan_type: "plus",
            },
          }),
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    sent,
    stop: () => server.stop(true),
  };
}

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function open(
  dataDir: string,
  endpoints: { gemini?: string; codexIssuer?: string },
): Promise<LlmRuntime> {
  const llm = await openLlm({
    dataDir,
    hostOrigin: "http://127.0.0.1:1",
    models: new GatewayModels(),
    warn: () => {},
    endpoints,
  });
  if (llm === undefined) throw new Error("the gateway did not start");
  stops.push(() => llm.close());
  return llm;
}

const geminiModels = (models: LlmModel[]) =>
  models.filter((model) => model.connector === "gemini");

describe("the gateway's accounts", () => {
  it("check, keep, disable, enable and remove a Google AI Studio key", async () => {
    const google = fakeGoogle();
    stops.push(google.stop);
    const dataDir = await tempDir("eta-llm-");
    let llm = await open(dataDir, { gemini: google.url });
    const { gateway } = llm;

    const login = await gateway.loginStart("gemini");
    expect(login).toMatchObject({
      connector: "gemini",
      flow: "api_key",
      status: "pending",
    });
    await expect(gateway.loginSubmit(login.id, "  ")).rejects.toMatchObject({
      code: "api_key_required",
    });
    await expect(gateway.loginSubmit(login.id, BAD)).rejects.toMatchObject({
      code: "invalid_api_key",
    });
    // A rejected key leaves the entry open for the right one.
    expect((await gateway.loginSubmit(login.id, GOOD)).status).toBe(
      "succeeded",
    );

    await until(async () => (await gateway.connections()).length === 1);
    const [key] = await gateway.connections();
    expect(key).toMatchObject({
      connector: "gemini",
      label: "…0001",
      state: "active",
    });
    expect(JSON.stringify(key)).not.toContain(GOOD);
    await until(async () => geminiModels(await gateway.models()).length > 0);
    const models = geminiModels(await gateway.models());
    expect(models.every((model) => model.available)).toBe(true);
    expect(models.some((model) => model.id.includes("image"))).toBe(false);

    // The same key again is refused.
    const again = await gateway.loginStart("gemini");
    await expect(gateway.loginSubmit(again.id, GOOD)).rejects.toMatchObject({
      code: "duplicate_api_key",
    });
    await gateway.loginCancel(again.id);

    // The check reads the key, and finds nothing to report.
    const [quota] = await gateway.usage();
    expect(quota).toEqual({ connectionId: key!.id, windows: [] });
    expect((await gateway.connections())[0]!.checkedAt).toBeDefined();

    // Disabled: the account and its models say so; enabled again: back.
    expect((await gateway.setEnabled(key!.id, false)).state).toBe("disabled");
    await until(async () =>
      geminiModels(await gateway.models()).every(
        (model) =>
          !model.available && model.reason?.code === "account_disabled",
      ),
    );
    expect((await gateway.setEnabled(key!.id, true)).state).toBe("active");
    await until(async () =>
      geminiModels(await gateway.models()).every((model) => model.available),
    );

    // Kept in CPA's config: there after a restart.
    await llm.close();
    llm = await open(dataDir, { gemini: google.url });
    expect((await llm.gateway.connections()).map((entry) => entry.id)).toEqual([
      key!.id,
    ]);

    // Removed: gone, and its models stay listed as unavailable.
    await llm.gateway.remove(key!.id);
    expect(await llm.gateway.connections()).toEqual([]);
    const left = geminiModels(await llm.gateway.models());
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((model) => model.reason?.code === "no_connection")).toBe(
      true,
    );
    await expect(llm.gateway.remove(key!.id)).rejects.toMatchObject({
      code: "not_found",
    });
  }, 60_000);

  it("move the Go gateway's providers.json into CPA's config", async () => {
    const dataDir = await tempDir("eta-llm-");
    const stateDir = join(dataDir, "llm");
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      join(stateDir, "providers.json"),
      JSON.stringify({
        gemini: [
          { api_key: GOOD, created_at: "2026-01-01T00:00:00Z" },
          { api_key: BAD, disabled: true, created_at: "2026-01-02T00:00:00Z" },
        ],
      }),
    );
    // What the Go gateway generated on its last start.
    await writeFile(
      join(stateDir, "config.yaml"),
      "# Generated by the eta host on every start; edits are overwritten.\nport: 0\ngemini-api-key:\n  - api-key: old\n",
    );
    const { gateway } = await open(dataDir, {});
    const connections = await gateway.connections();
    expect(connections.map((entry) => [entry.label, entry.state])).toEqual([
      ["…0001", "active"],
      ["…0002", "disabled"],
    ]);
    expect(existsSync(join(stateDir, "providers.json"))).toBe(false);
    expect(await readFile(join(stateDir, "config.yaml"), "utf8")).toContain(
      GOOD,
    );
  }, 60_000);

  it.skipIf(process.platform === "win32")(
    "hand a Codex device login to CPA as a credential file",
    async () => {
      const openai = fakeOpenAI();
      stops.push(openai.stop);
      const dataDir = await tempDir("eta-llm-");
      const { gateway } = await open(dataDir, { codexIssuer: openai.url });

      const login = await gateway.loginStart("codex");
      expect(login).toMatchObject({
        connector: "codex",
        flow: "oauth_device",
        status: "pending",
        userCode: "ABCD-1234",
        url: "https://auth.openai.com/codex/device",
      });
      await until(
        async () => (await gateway.loginPoll(login.id)).status === "succeeded",
      );
      // What was asked of OpenAI, in order: the code, polls until approved, the exchange.
      expect(openai.sent.map((request) => request.path)).toEqual([
        "/api/accounts/deviceauth/usercode",
        "/api/accounts/deviceauth/token",
        "/api/accounts/deviceauth/token",
        "/oauth/token",
      ]);
      expect(JSON.parse(openai.sent[0]!.body)).toEqual({
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      });
      expect(JSON.parse(openai.sent[1]!.body)).toEqual({
        device_auth_id: "dev-1",
        user_code: "ABCD-1234",
      });
      expect(
        Object.fromEntries(new URLSearchParams(openai.sent[3]!.body)),
      ).toEqual({
        grant_type: "authorization_code",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code: "code",
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
        code_verifier: "verifier",
      });
      await until(async () => (await gateway.connections()).length === 1);
      const [account] = await gateway.connections();
      expect(account).toMatchObject({
        connector: "codex",
        label: "ada@example.com",
        plan: "plus",
        state: "active",
      });
      // The credential file, as CPA's own device login writes it.
      const auths = join(dataDir, "llm", "auths");
      // CPA keeps a `.lock` beside it.
      const [file] = (await readdir(auths)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(file).toMatch(/^codex-[0-9a-f]{8}-ada@example\.com-plus\.json$/);
      const credential = JSON.parse(await readFile(join(auths, file!), "utf8"));
      expect(credential).toMatchObject({
        type: "codex",
        access_token: "access",
        refresh_token: "refresh",
        account_id: "acct-1",
        email: "ada@example.com",
        plan_type: "plus",
      });
      expect(
        Date.parse(credential.expired) - Date.parse(credential.last_refresh),
      ).toBe(3_600_000);
      // CPA serves its models; a disabled account serves none of them.
      await until(async () =>
        (await gateway.models()).some(
          (model) => model.connector === "codex" && model.available,
        ),
      );
      expect((await gateway.setEnabled(account!.id, false)).state).toBe(
        "disabled",
      );
      await gateway.remove(account!.id);
      expect(await gateway.connections()).toEqual([]);
      expect(
        await readFile(join(dataDir, "llm", "models.json"), "utf8"),
      ).toContain('"connector": "codex"');

      await expect(gateway.loginPoll("no-such-login")).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(gateway.loginStart("nobody")).rejects.toMatchObject({
        code: "not_found",
      });
    },
    60_000,
  );

  it("keep a Codex login whose email has two dots in a row", async () => {
    const email = "first..last@example.com";
    const openai = fakeOpenAI("ok", email);
    stops.push(openai.stop);
    const dataDir = await tempDir("eta-llm-");
    const { gateway } = await open(dataDir, { codexIssuer: openai.url });
    const login = await gateway.loginStart("codex");
    await until(
      async () => (await gateway.loginPoll(login.id)).status !== "pending",
    );
    expect((await gateway.loginPoll(login.id)).status).toBe("succeeded");
    // CPA took the file under that name, and serves the account.
    // CPA keeps a `.lock` beside it.
    const [file] = (await readdir(join(dataDir, "llm", "auths"))).filter(
      (name) => name.endsWith(".json"),
    );
    expect(file).toMatch(
      /^codex-[0-9a-f]{8}-first\.\.last@example\.com-plus\.json$/,
    );
    await until(async () => (await gateway.connections()).length === 1);
    expect((await gateway.connections())[0]).toMatchObject({
      connector: "codex",
      label: email,
      state: "active",
    });
  }, 60_000);

  it("end a Codex login the provider refuses, or whose exchange fails, with its code", async () => {
    for (const [mode, code] of [
      ["refused", "login_failed"],
      ["exchange-fails", "login_save_failed"],
    ] as const) {
      const openai = fakeOpenAI(mode);
      stops.push(openai.stop);
      const { gateway } = await open(await tempDir("eta-llm-"), {
        codexIssuer: openai.url,
      });
      const login = await gateway.loginStart("codex");
      await until(
        async () => (await gateway.loginPoll(login.id)).status !== "pending",
      );
      expect(await gateway.loginPoll(login.id)).toMatchObject({
        status: "failed",
        error: { code },
      });
      expect(await gateway.connections()).toEqual([]);
    }
  }, 60_000);
});
