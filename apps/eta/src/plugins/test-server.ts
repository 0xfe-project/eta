/**
 * A connection test for one plugin server: the host connects the way a session would (the same
 * config merge, the same MCP client), lists what the server offers, and closes. It never calls a
 * tool. Whatever the server said, a secret the config carries is masked before it is returned.
 */
import type { PluginTestResult } from "@eta/client-contracts";
import type { AuthProviderFor, McpServerDefinition } from "@eta/mcp";
import { ServerManager } from "@eta/mcp";
import { CURSOR_AUTH_HEADER, isCursorServer } from "./cursor-login";

const TEST_TIMEOUT_MS = 15_000;
const MAX_TOOLS = 100;
const MAX_TEXT = 300;
const MAX_PARAMS = 12;

const empty = (
  status: PluginTestResult["status"],
  message: string,
  ms = 0,
): PluginTestResult => ({
  status,
  message,
  ms,
  serverName: null,
  serverVersion: null,
  tools: [],
  toolCount: 0,
  resourceCount: null,
  promptCount: null,
  resources: [],
  prompts: [],
});

export const notTested = empty;

/** `text` with every secret value, and any bearer token, replaced; short enough to show. */
function mask(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets)
    if (secret.length >= 3) out = out.split(secret).join("***");
  return out
    .replace(/Bearer\s+[\w.~+/=-]{6,}/gi, "Bearer ***")
    .slice(0, MAX_TEXT);
}

/** The values a config carries, and the token part of a bearer one. */
export function secretsOf(entry: {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}): string[] {
  const values = [
    ...Object.values(entry.headers ?? {}),
    ...Object.values(entry.env ?? {}),
  ];
  return values
    .flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
    .filter((v) => v !== "");
}

function reasonOf(error: unknown, timedOut: boolean): string {
  if (timedOut) return "no answer within 15 seconds";
  const text = error instanceof Error ? error.message : String(error);
  const low = text.toLowerCase();
  if (/another host|redirect/.test(low))
    return "the server redirected to another host; request headers are sent only to the server's own host, so it was refused";
  if (/enotfound|eai_again|getaddrinfo|dns/.test(low))
    return "the host name could not be resolved (DNS)";
  if (/cert|tls|ssl|self.signed|unable to verify/.test(low))
    return "the TLS certificate was not accepted";
  if (/econnrefused|connection refused|unable to connect/.test(low))
    return "the connection was refused";
  if (/401|credential rejected/.test(low))
    return "credential rejected (HTTP 401)";
  if (/enoent|spawn/.test(low))
    return "the server's command could not be started";
  if (/json|protocol|invalid|unexpected|parse|schema/.test(low))
    return "the server did not answer as an MCP server does";
  return "the connection failed";
}

interface Rejection {
  text: string;
  /** A request header the server's words say is missing, when they do. */
  header?: string;
}

/** "Missing Cursor credential in x-cursor-auth", "x-foo header is required": the header named, or none. */
function missingHeader(text: string): string | undefined {
  const name = "([a-z][a-z0-9]*(?:-[a-z0-9]+)+)";
  const found =
    new RegExp(
      `\\bmissing\\W[^\\n]{0,60}?\\b(?:in|from)\\s+(?:the\\s+)?${name}`,
      "i",
    ).exec(text) ??
    new RegExp(
      `\\b${name}\\s+header\\s+(?:is\\s+)?(?:required|missing)`,
      "i",
    ).exec(text) ??
    new RegExp(`\\bmissing\\s+(?:the\\s+)?${name}\\s+header`, "i").exec(text);
  return found?.[1]?.toLowerCase();
}

/** What a 401 said: its challenge's error, description and metadata address, and the start of its body. */
async function rejectionOf(
  response: Response,
  sent: readonly (string | null)[],
): Promise<Rejection> {
  const challenge = response.headers.get("www-authenticate") ?? "";
  const field = (name: string) =>
    new RegExp(`${name}="?([^",]*)"?`, "i").exec(challenge)?.[1];
  const parts = [
    "HTTP 401",
    ...[
      ["error", "error"],
      ["error_description", "description"],
      ["resource_metadata", "metadata"],
    ].flatMap(([key, label]) =>
      field(key!) === undefined ? [] : [`${label}=${field(key!)}`],
    ),
  ];
  // A server may echo what it was sent: the token we sent never leaves here.
  let text = await response
    .clone()
    .text()
    .catch(() => "");
  for (const one of sent) {
    const token = one?.replace(/^Bearer\s+/i, "") ?? "";
    if (token.length >= 3) text = text.split(token).join("***");
  }
  const body = text
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is dropped here
    .replace(/[\u0000-\u001F]+/g, " ")
    .trim()
    .slice(0, 200);
  if (body !== "") parts.push(`body: ${body}`);
  const header = missingHeader(text);
  return header === undefined
    ? { text: parts.join(", ") }
    : { text: parts.join(", "), header };
}

/**
 * What a request to the server says about sign-in: true when its 401 challenge is OAuth. It carries
 * the server's own headers (a Cursor-hosted server answers a request without its x-cursor-auth by a
 * bare 401, with no challenge) and goes to the server's own address only.
 */
async function declaresOauth(
  url: string,
  own: Record<string, string> | undefined,
  send: typeof fetch,
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    const response = await send(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...Object.fromEntries(
          Object.entries(own ?? {}).filter(([, value]) => value.trim() !== ""),
        ),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "eta", version: "0" },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 401) return false;
    const challenge = response.headers.get("www-authenticate") ?? "";
    return (
      /\bBearer\b/i.test(challenge) && /resource_metadata\s*=/i.test(challenge)
    );
  } catch {
    return false;
  }
}

function cursorFlag(definition: McpServerDefinition): { cursorServer?: true } {
  return definition.url !== undefined && isCursorServer(definition.url)
    ? { cursorServer: true }
    : {};
}

/** Connect once, list, close. `secrets` are masked out of anything said. */
export async function testConnection(
  definition: McpServerDefinition,
  secrets: readonly string[],
  timeoutMs = TEST_TIMEOUT_MS,
  stored?: AuthProviderFor,
  /** Tests only: the fetch the connection goes through, in place of the network. */
  fetchImpl?: typeof fetch,
): Promise<PluginTestResult> {
  const started = Date.now();
  // The server's own 401 (what it said, never the token we sent), so the result can say why.
  let rejected: Rejection | undefined;
  const base = fetchImpl ?? fetch;
  const recording = (async (input, init) => {
    const response = await base(input, init);
    if (
      response.status === 401 &&
      definition.url !== undefined &&
      String(input) === new URL(definition.url).href
    ) {
      const next = await rejectionOf(response, [
        new Headers(init?.headers).get("authorization"),
        definition.tokenHeader === undefined
          ? null
          : new Headers(init?.headers).get(definition.tokenHeader.name),
      ]);
      // Several 401s can follow one another (retries, a refresh): one that named a header is kept.
      if (rejected?.header === undefined || next.header !== undefined)
        rejected = next;
    }
    return response;
  }) as typeof fetch;
  // A server declared `oauth` is first reached without a sign-in: a 401 then says it needs one,
  // and nothing is requested on the user's behalf by a test.
  const declaredOauth = definition.auth === "oauth";
  // With a stored sign-in the test sends it, as a launch does; only without one is auth dropped.
  if (declaredOauth && stored === undefined) {
    definition = { ...definition };
    delete definition.auth;
  }
  const manager = new ServerManager({
    checkIntervalMs: 0,
    idleTimeoutMs: 0,
    requestTimeoutMs: timeoutMs,
    fetch: recording as never,
    ...(stored === undefined ? {} : { authProviderFor: stored }),
  });
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
      // The server's own challenge decides, not the config's default: a header the user set does not
      // hide that the server also signs in.
      const sent = Object.values(definition.headers ?? {}).some(
        (value) => value.trim() !== "",
      );
      const challenge =
        definition.url !== undefined &&
        (await declaresOauth(definition.url, definition.headers, base));
      if (
        cursorFlag(definition).cursorServer === true &&
        !Object.keys(definition.headers ?? {}).some(
          (name) => name.toLowerCase() === CURSOR_AUTH_HEADER,
        )
      ) {
        // A Cursor-hosted server with no Cursor credential saved: that comes first, whatever the 401
        // said (it may name the header, or only "not logged in"). Then the service's own sign-in.
        return {
          ...empty(
            "needs_login",
            `no Cursor account credential is saved for this server: sign in with your Cursor account first, then sign in to the service itself`,
            elapsed(),
          ),
          requiredHeader: CURSOR_AUTH_HEADER,
          cursorServer: true,
        };
      }
      if (stored === undefined && rejected?.header !== undefined) {
        // Nothing is signed in yet, and the server's first demand is a header of its own: for a
        // Cursor-hosted server that is a Cursor account credential, then the service's own sign-in.
        const header = rejected.header;
        return {
          ...empty(
            "needs_login",
            `the server requires the ${header} header (for Cursor-hosted servers a Cursor account credential) before its own sign-in: sign in with your Cursor account first, then sign in to the service (${mask(rejected.text, secrets)})`,
            elapsed(),
          ),
          requiredHeader: header,
          ...cursorFlag(definition),
        };
      }
      if (stored !== undefined && rejected?.header !== undefined) {
        // The sign-in is stored; this server asks for something else (a header of its own client's).
        // That is not an expired sign-in, and signing in again would not help.
        const header = rejected.header;
        return {
          ...empty(
            "failed",
            `the sign-in is saved, but the server requires the ${header} header (not an OAuth token; for Cursor-hosted servers a Cursor account credential), which eta cannot provide (${mask(rejected.text, secrets)})`,
            elapsed(),
          ),
          requiredHeader: header,
          ...cursorFlag(definition),
        };
      }
      if (challenge || declaredOauth) {
        return empty(
          "needs_login",
          stored !== undefined
            ? `the server did not accept the stored sign-in${rejected === undefined ? "" : ` (${mask(rejected.text, secrets)})`}; sign in again`
            : sent
              ? "credential rejected; this server also supports login"
              : "this server needs a sign-in",
          elapsed(),
        );
      }
      return empty(
        "failed",
        mask(
          connection.authMessage ?? "credential rejected (HTTP 401)",
          secrets,
        ),
        elapsed(),
      );
    }
    const client = connection.client!;
    const info = client.getServerVersion();
    const caps = client.getServerCapabilities() ?? {};
    const listed = caps.tools ? await client.listTools() : { tools: [] };
    const resources = caps.resources ? await client.listResources() : null;
    const prompts = caps.prompts ? await client.listPrompts() : null;
    const tools = (listed.tools as Array<Record<string, unknown>>)
      .slice(0, MAX_TOOLS)
      .map((tool) => {
        const props = (
          tool.inputSchema as
            | { properties?: Record<string, unknown> }
            | undefined
        )?.properties;
        return {
          name: mask(String(tool.name), secrets),
          description: mask(
            typeof tool.description === "string" ? tool.description : "",
            secrets,
          ),
          params: Object.keys(props ?? {}).slice(0, MAX_PARAMS),
        };
      });
    const resourceList = (resources?.resources ?? []) as Array<
      Record<string, unknown>
    >;
    const promptList = (prompts?.prompts ?? []) as Array<
      Record<string, unknown>
    >;
    return {
      status: "ok",
      message: "",
      ms: elapsed(),
      serverName:
        info?.name === undefined ? null : mask(String(info.name), secrets),
      serverVersion:
        info?.version === undefined
          ? null
          : mask(String(info.version), secrets),
      tools,
      toolCount: listed.tools.length,
      resourceCount: resources === null ? null : resources.resources.length,
      promptCount: prompts === null ? null : prompts.prompts.length,
      resources: resourceList.slice(0, MAX_TOOLS).map((one) => ({
        name: mask(String(one.name ?? one.uri ?? ""), secrets),
        description: mask(
          typeof one.description === "string" ? one.description : "",
          secrets,
        ),
        params: [],
      })),
      prompts: promptList.slice(0, MAX_TOOLS).map((one) => ({
        name: mask(String(one.name ?? ""), secrets),
        description: mask(
          typeof one.description === "string" ? one.description : "",
          secrets,
        ),
        params: ((one.arguments as Array<{ name?: unknown }> | undefined) ?? [])
          .map((arg) => String(arg.name ?? ""))
          .filter((name) => name !== "")
          .slice(0, MAX_PARAMS),
      })),
    };
  } catch (error) {
    return empty("failed", mask(reasonOf(error, timedOut), secrets), elapsed());
  } finally {
    clearTimeout(timer);
    await manager.closeAll().catch(() => undefined);
  }
}
