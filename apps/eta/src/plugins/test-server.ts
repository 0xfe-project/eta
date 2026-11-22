/**
 * A connection test for one plugin server: the host connects the way a session would (the same
 * config merge, the same MCP client), lists what the server offers, and closes. It never calls a
 * tool. Whatever the server said, a secret the config carries is masked before it is returned.
 */
import type { PluginTestResult } from "@eta/client-contracts";
import type { McpServerDefinition } from "@eta/mcp";
import { ServerManager } from "@eta/mcp";

export const TEST_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 100;
const MAX_TEXT = 300;
const MAX_PARAMS = 12;

const empty = (status: PluginTestResult["status"], message: string, ms = 0): PluginTestResult => ({
  status,
  message,
  ms,
  serverName: null,
  serverVersion: null,
  tools: [],
  toolCount: 0,
  resourceCount: null,
  promptCount: null,
});

export const notTested = empty;

/** `text` with every secret value, and any bearer token, replaced; short enough to show. */
export function mask(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 3) out = out.split(secret).join("***");
  return out.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, "Bearer ***").slice(0, MAX_TEXT);
}

/** The values a config carries, and the token part of a bearer one. */
export function secretsOf(entry: { headers?: Record<string, string>; env?: Record<string, string> }): string[] {
  const values = [...Object.values(entry.headers ?? {}), ...Object.values(entry.env ?? {})];
  return values.flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")]).filter((v) => v !== "");
}

function reasonOf(error: unknown, timedOut: boolean): string {
  if (timedOut) return "no answer within 15 seconds";
  const text = error instanceof Error ? error.message : String(error);
  const low = text.toLowerCase();
  if (/another host|redirect/.test(low)) return "the server redirected to another host; request headers are sent only to the server's own host, so it was refused";
  if (/enotfound|eai_again|getaddrinfo|dns/.test(low)) return "the host name could not be resolved (DNS)";
  if (/cert|tls|ssl|self.signed|unable to verify/.test(low)) return "the TLS certificate was not accepted";
  if (/econnrefused|connection refused|unable to connect/.test(low)) return "the connection was refused";
  if (/401|credential rejected/.test(low)) return "credential rejected (HTTP 401)";
  if (/enoent|spawn/.test(low)) return "the server's command could not be started";
  if (/json|protocol|invalid|unexpected|parse|schema/.test(low)) return "the server did not answer as an MCP server does";
  return "the connection failed";
}

/** Connect once, list, close. `secrets` are masked out of anything said. */
export async function testConnection(
  definition: McpServerDefinition,
  secrets: readonly string[],
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<PluginTestResult> {
  const started = Date.now();
  // A server declared `oauth` is first reached without a sign-in: a 401 then says it needs one,
  // and nothing is requested on the user's behalf by a test.
  const declaredOauth = definition.auth === "oauth";
  if (declaredOauth) {
    definition = { ...definition };
    delete definition.auth;
  }
  const manager = new ServerManager({ checkIntervalMs: 0, idleTimeoutMs: 0, requestTimeoutMs: timeoutMs });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void manager.closeAll();
  }, timeoutMs);
  const elapsed = () => Date.now() - started;
  try {
    const connection = await manager.connect("plugin-test", definition, {
      force: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (connection.status === "needs-auth") {
      const login = declaredOauth;
      return empty(
        login ? "needs_login" : "failed",
        mask(login ? "this server needs a sign-in" : (connection.authMessage ?? "credential rejected (HTTP 401)"), secrets),
        elapsed(),
      );
    }
    const client = connection.client!;
    const info = client.getServerVersion();
    const caps = client.getServerCapabilities() ?? {};
    const listed = caps.tools ? await client.listTools() : { tools: [] };
    const resources = caps.resources ? await client.listResources() : null;
    const prompts = caps.prompts ? await client.listPrompts() : null;
    const tools = (listed.tools as Array<Record<string, unknown>>).slice(0, MAX_TOOLS).map((tool) => {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      return {
        name: mask(String(tool.name), secrets),
        description: mask(typeof tool.description === "string" ? tool.description : "", secrets),
        params: Object.keys(props ?? {}).slice(0, MAX_PARAMS),
      };
    });
    return {
      status: "ok",
      message: "",
      ms: elapsed(),
      serverName: info?.name === undefined ? null : mask(String(info.name), secrets),
      serverVersion: info?.version === undefined ? null : mask(String(info.version), secrets),
      tools,
      toolCount: listed.tools.length,
      resourceCount: resources === null ? null : resources.resources.length,
      promptCount: prompts === null ? null : prompts.prompts.length,
    };
  } catch (error) {
    return empty("failed", mask(reasonOf(error, timedOut), secrets), elapsed());
  } finally {
    clearTimeout(timer);
    await manager.closeAll().catch(() => undefined);
  }
}
