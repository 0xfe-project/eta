import type { McpTuning } from "@eta/app/src/product";
/**
 * `/mcp` against a real host: servers declared in the host's `~/.eta/mcp.json`, read through the
 * `mcp` target; connecting them, and signing in to an OAuth one at a fake authorization server
 * that the host's MCP requests are routed to.
 */
import type { AgentView, McpServerView } from "@eta/client-contracts";
import type { HostObserver } from "../ext-support/host-observer";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFakeAuthServer,
  MCP_URL,
} from "../../../../packages/eta-mcp/test/oauth/fake-auth-server";
import { withoutCaptainRows } from "../../src/ext/kit/captain";
import mcp from "../../src/ext/mcp";
import { observeHost } from "../ext-support/host-observer";
import { recordCalls, squash } from "../ext-support/record-calls";
import { renderWithHost } from "../ext-support/render-with-host";
import { baseUrl } from "../support/host";
import { tempDir } from "../support/temp";
import { KEYS } from "../ui-support/render";

type FetchLike = NonNullable<McpTuning["fetch"]>;

const BROKEN_URL = "https://broken.test/mcp";

/**
 * MCP requests as the host makes them: the fake authorization server, an MCP endpoint behind it
 * that answers a token the fake issued, and a server that always fails.
 */
function mcpNetwork(auth: ReturnType<typeof createFakeAuthServer>): FetchLike {
  return async (input, init) => {
    if (String(input) === BROKEN_URL)
      return new Response("the broken server is down", { status: 500 });
    const bearer = new Headers(init?.headers).get("authorization");
    if (String(input) !== MCP_URL || !bearer?.startsWith("Bearer access-"))
      return await auth.fetch(input, init);
    if ((init?.method ?? "GET") !== "POST")
      return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body)) as {
      id?: number;
      method: string;
      params?: Record<string, unknown>;
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "remote", version: "1.0.0" },
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "whoami",
                  description: "Say who the token belongs to.",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            }
          : {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
}

/** The servers of the agents the test made: Captain, which every host makes, has its own. */
const servers = (host: HostObserver) =>
  withoutCaptainRows(
    host.section<McpServerView[]>("mcp", "list") ?? [],
    host.section<AgentView[]>("agents", "list"),
  );
const server = (host: HostObserver, name: string) =>
  servers(host).find((view) => view.server === name);

/** A host whose `mcp.json` declares `remote` (OAuth) and `broken`, an agent Ada, and `/mcp` open. */
async function opened(options: { declare?: boolean; agent?: boolean } = {}) {
  const dataDir = await tempDir("eta-tui-mcp-");
  if (options.declare ?? true) {
    await mkdir(join(dataDir, ".eta"), { recursive: true });
    await writeFile(
      join(dataDir, ".eta", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: MCP_URL, auth: "oauth" },
          broken: { url: BROKEN_URL },
        },
      }),
    );
  }
  const auth = createFakeAuthServer();
  const r = await renderWithHost({
    extensions: [mcp],
    host: {
      dataDir,
      overrides: {
        mcp: {
          fetch: mcpNetwork(auth),
          manager: { resolvers: false, checkIntervalMs: 0 },
        },
      },
    },
    columns: 160,
    rows: 40,
  });
  const host = await observeHost(r.host);
  if (options.agent ?? true) {
    await host.client.call("agents", "create", { name: "Ada" });
    if (options.declare ?? true)
      await host.until(() => servers(host).length === 2);
  }
  const calls = recordCalls(r.wire);
  await r.runCommand("/mcp");
  await r.waitFor("MCP servers");
  return { r, host, auth, calls };
}

type Opened = Awaited<ReturnType<typeof opened>>;

/** Opens the server on the given row of the list (the list is sorted: broken, then remote). */
async function openServer(r: Opened["r"], row: number, name: string) {
  for (let i = 0; i < row; i += 1) await r.press(KEYS.down);
  await r.press(KEYS.enter);
  await r.waitFor(`Declared in: ~/.eta/mcp.json`);
  expect(r.screen()).toContain(name);
}

/** Picks the action with this label in the server's action list. */
async function runAction(r: Opened["r"], label: string) {
  const labels = ["Connect", "Reconnect", "Sign in"];
  const index = labels.indexOf(label);
  for (let i = 0; i < index; i += 1) await r.press(KEYS.down);
  await r.press(KEYS.enter);
}

async function startLogin(s: Opened) {
  await openServer(s.r, 1, "remote");
  await runAction(s.r, "Sign in");
  await s.r.waitFor("Open this address in a browser to sign in");
  const login = s.calls.find((call) => call.op === "mcp.login")!;
  const outcome = await login.outcome;
  if (!outcome.ok) throw new Error("the login did not start");
  const { authorizationUrl, pendingId } = outcome.value as {
    authorizationUrl: string;
    pendingId: string;
  };
  return { login, authorizationUrl, pendingId };
}

describe("/mcp", () => {
  it("lists each server's agent, name, state and tool count, and marks one that needs a sign-in", async () => {
    const { r } = await opened();
    await r.waitFor("remote");
    const screen = r.screen();
    expect(screen).toMatch(/Ada · broken\s+not connected · tools: 0/);
    expect(screen).toMatch(
      /Ada · remote\s+not connected · tools: 0.*sign-in needed/,
    );
    expect(screen.match(/sign-in needed/g)).toHaveLength(1);
    expect(screen).toContain("Enter open");
  });

  it("says when there are no servers, and how to add them", async () => {
    const { r } = await opened({ declare: false });
    await r.waitFor("No MCP servers");
    expect(r.screen()).toContain("/edit-host-config mcp.json");
  });

  it("offers connect and reconnect, and sign in only to a server that needs it", async () => {
    const { r } = await opened();
    await openServer(r, 0, "broken");
    expect(r.screen()).toContain("Connect");
    expect(r.screen()).toContain("Reconnect");
    expect(r.screen()).not.toContain("Sign in");
    await r.press(KEYS.escape);
    await openServer(r, 1, "remote");
    expect(r.screen()).toContain("Sign in");
  });

  it("shows the host's message when connecting fails, and the server's error", async () => {
    const { r, host, calls } = await opened();
    await openServer(r, 0, "broken");
    await runAction(r, "Connect");
    await r.waitUntil(
      () => calls.some((call) => call.op === "mcp.connect"),
      "the connect call",
    );
    const outcome = await calls.find((call) => call.op === "mcp.connect")!
      .outcome;
    expect(outcome.ok).toBe(true);
    const answer = (outcome as { value: { ok: boolean; message: string } })
      .value;
    expect(answer.ok).toBe(false);
    // The answer has a line of its own, apart from the server's `Error:` line, which may say the
    // same words.
    const ownLine = () =>
      r
        .screen()
        .split("\n")
        .map((line) => line.replaceAll("│", "").trim())
        .some(
          (line) =>
            line !== "" &&
            !line.startsWith("Error:") &&
            answer.message.startsWith(line.slice(0, 40)),
        );
    await r.waitUntil(ownLine, "the host's message to show");
    // The error the host keeps for the server shows on its page too.
    await host.until(() => server(host, "broken")?.error != null);
    await r.waitUntil(
      () =>
        squash(r.screen()).includes(
          squash(`Error: ${server(host, "broken")!.error!}`),
        ),
      "the server's error to show",
    );
  });

  it("connects once for two Enters read at once", async () => {
    const { r, calls } = await opened();
    await openServer(r, 0, "broken");
    await r.press("\r\r");
    await r.waitUntil(
      () => calls.some((call) => call.op === "mcp.connect"),
      "the connect call",
    );
    await calls.find((call) => call.op === "mcp.connect")!.outcome;
    await r.settle(300);
    expect(calls.filter((call) => call.op === "mcp.connect")).toHaveLength(1);
  });

  it("reconnects through mcp.reconnect", async () => {
    const { r, calls } = await opened();
    await openServer(r, 0, "broken");
    await runAction(r, "Reconnect");
    await r.waitUntil(
      () => calls.some((call) => call.op === "mcp.reconnect"),
      "the reconnect call",
    );
    expect(calls.find((call) => call.op === "mcp.reconnect")!.args).toEqual({
      agentId: expect.any(String),
      server: "broken",
    });
  });

  it("signs in with the address pasted back, sent from the connection's origin", async () => {
    const s = await opened();
    const { login, authorizationUrl, pendingId } = await startLogin(s);
    expect(login.args).toMatchObject({
      server: "remote",
      redirectOrigin: baseUrl(s.r.host),
    });
    expect(new URL(authorizationUrl).searchParams.get("redirect_uri")).toBe(
      `${baseUrl(s.r.host)}/mcp/oauth/callback`,
    );
    // The whole address is on the screen, wrapped if it must be.
    expect(squash(s.r.screen())).toContain(authorizationUrl);
    expect(s.r.screen()).toContain("paste the address it ends up on below");

    const redirect = s.auth.approve(authorizationUrl);
    await s.r.press(KEYS.paste(redirect));
    await s.r.press(KEYS.enter);
    await s.host.until(() => server(s.host, "remote")?.auth === "signed_in");
    expect(
      s.calls.find((call) => call.op === "mcp.completeLogin")!.args,
    ).toEqual({ pendingId, callbackUrl: redirect });
    await s.r.waitFor("Signed in to remote");
    await s.r.waitForGone("Open this address in a browser to sign in");
  });

  it("closes the sign-in by itself when the browser came back to the host", async () => {
    const s = await opened();
    const { authorizationUrl } = await startLogin(s);
    const redirect = new URL(s.auth.approve(authorizationUrl));
    // The browser's return, as it reaches the host's callback route.
    const response = await fetch(
      `${baseUrl(s.r.host)}/mcp/oauth/callback${redirect.search}`,
    );
    expect(response.status).toBe(200);
    await s.r.waitFor("Signed in to remote");
    await s.r.waitForGone("Open this address in a browser to sign in");
    expect(s.calls.filter((call) => call.op === "mcp.completeLogin")).toEqual(
      [],
    );
  });

  it("shows the host's words for an address it does not accept, and keeps asking", async () => {
    const s = await opened();
    const { authorizationUrl } = await startLogin(s);
    const forged = new URL(s.auth.approve(authorizationUrl));
    forged.searchParams.set("state", "forged");
    await s.r.press(KEYS.paste(forged.href));
    await s.r.press(KEYS.enter);
    await s.r.waitUntil(
      () => s.calls.some((call) => call.op === "mcp.completeLogin"),
      "the completeLogin call",
    );
    const outcome = await s.calls.find(
      (call) => call.op === "mcp.completeLogin",
    )!.outcome;
    expect(outcome.ok).toBe(false);
    const words = (outcome as { error: Error }).error.message;
    expect(words).toMatch(/state/i);
    await s.r.waitUntil(
      () => squash(s.r.screen()).includes(squash(words)),
      "the host's words to show",
    );
    expect(s.r.screen()).toContain("Open this address in a browser to sign in");
    expect(server(s.host, "remote")?.auth).toBe("needs_login");
  });

  it("gives up the sign-in on Esc, then goes back to the list, then closes", async () => {
    const s = await opened();
    await startLogin(s);
    await s.r.press(KEYS.escape);
    await s.r.waitForGone("Open this address in a browser to sign in");
    expect(s.r.screen()).toContain("Declared in: ~/.eta/mcp.json");
    await s.r.press(KEYS.escape);
    await s.r.waitForGone("Declared in: ~/.eta/mcp.json");
    expect(s.r.screen()).toContain("MCP servers");
    await s.r.press(KEYS.escape);
    await s.r.waitForGone("MCP servers");
  });
});
