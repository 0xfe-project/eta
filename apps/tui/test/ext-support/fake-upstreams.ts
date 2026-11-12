/**
 * Stand-ins for the providers the model gateway logs in to, written after `fakeGoogle` and
 * `fakeOpenAI` in apps/eta/test/llm-gateway.test.ts: Google's model list that checks an API key,
 * and OpenAI's device authorization. The gateway (CLIProxyAPI) itself is real.
 */
import { Buffer } from "node:buffer";
import { afterEach } from "vitest";

const servers: { stop: () => unknown }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

export const GOOD_KEY = "AIzaGOODGOODGOOD0001";
export const BAD_KEY = "AIzaBADBADBADBAD0002";

/**
 * Google's model list: the keys in `accepted` list (nothing), any other is invalid. A test may
 * take a key out of `accepted` to make an account's next check fail.
 */
export function fakeGoogle(): { url: string; accepted: Set<string> } {
  const accepted = new Set([GOOD_KEY]);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const key = request.headers.get("x-goog-api-key");
      if (key !== null && accepted.has(key))
        return Response.json({ models: [] });
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
  servers.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, accepted };
}

export const USER_CODE = "ABCD-1234";

const jwt = (claims: unknown) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

/**
 * OpenAI's device authorization. `ok`: approved on the second poll. `refused`: the provider ends
 * the login with an error. `pending`: never approved. `sent` keeps the paths it was asked for.
 */
export function fakeOpenAI(mode: "ok" | "refused" | "pending" = "ok"): {
  url: string;
  sent: string[];
} {
  let polls = 0;
  const sent: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      sent.push(pathname);
      if (pathname === "/api/accounts/deviceauth/usercode")
        return Response.json({
          device_auth_id: "dev-1",
          user_code: USER_CODE,
          interval: "1",
        });
      if (pathname === "/api/accounts/deviceauth/token") {
        if (mode === "refused")
          return Response.json({ error: "access_denied" }, { status: 400 });
        if (mode === "pending" || ++polls < 2)
          return new Response("pending", { status: 403 });
        return Response.json({
          authorization_code: "code",
          code_verifier: "verifier",
        });
      }
      if (pathname === "/oauth/token")
        return Response.json({
          id_token: jwt({
            email: "ada@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-1",
              chatgpt_plan_type: "plus",
            },
          }),
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        });
      return new Response("not found", { status: 404 });
    },
  });
  servers.push({ stop: () => server.stop(true) });
  return { url: `http://127.0.0.1:${server.port}`, sent };
}
