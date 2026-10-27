/**
 * The gateway inside the host: CPA started, the account and catalog reader over it, the agents'
 * keys, and the model layer's view of it.
 *
 * The host's own model layer calls CPA's `/v1` directly, with CPA's key. Sessions (on this
 * machine and on daemons) reach it through the host's `/llm/v1/*` with their agent's key, which
 * is checked here and swapped for CPA's: nothing outside this process knows CPA's key.
 */
import type { CpaConfig } from "@cpajs/cpa/client";
import type { Connector, ConnectorContext } from "./connectors";
import type { GatewayModels } from "./models";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Codex } from "./codex";
import { Cpa } from "./cpa";
import { Gateway } from "./gateway";
import { Gemini } from "./gemini";
import { AgentKeys } from "./keys";
import { LLM_ROUTE } from "./route";
import { XAI } from "./xai";

export interface LlmOptions {
  /** Merged over CPA's generated config: how a test points an upstream at a fake server. */
  cpaExtra?: CpaConfig | undefined;
  /** Where the connectors log in and check keys; tests point them at fakes. */
  endpoints?: { codexIssuer?: string; gemini?: string } | undefined;
}

export interface LlmRuntime {
  readonly gateway: Gateway;
  /** Where sessions on the host's machine reach the gateway: `/v1` hangs off it. */
  readonly origin: string;
  /** The `/v1`-only key of one agent (its id), for its sessions' tools. */
  scopedKey: (agentId: string) => string;
  /** End an agent's keys, when the agent is gone. */
  revoke: (agentId: string) => Promise<void>;
  /**
   * Serve a request a session made to `/llm/v1/...`: only an agent's key passes, and only `/v1`
   * is reachable. The body and the answer stream.
   */
  forward: (request: Request) => Promise<Response>;
  /** Stop CPA. */
  close: () => Promise<void>;
}

/**
 * Start the gateway under the data directory and point the model layer at it. Resolves with
 * nothing when CPA cannot start; the reason goes to `warn`. `hostOrigin` is the host's own
 * address as this machine reaches it.
 */
export async function openLlm(
  options: LlmOptions & {
    dataDir: string;
    hostOrigin: string;
    models: GatewayModels;
    warn: (message: string) => void;
  },
): Promise<LlmRuntime | undefined> {
  const { warn, models } = options;
  const stateDir = join(options.dataDir, "llm");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let cpa: Cpa;
  try {
    cpa = await Cpa.start({ stateDir, extra: options.cpaExtra, warn });
  } catch (error) {
    warn(`[eta] llm: the gateway did not start: ${String(error)}`);
    return undefined;
  }
  const context: ConnectorContext = { cpa: () => cpa.client, warn };
  const connectors: Connector[] = [
    new Codex(context, options.endpoints?.codexIssuer),
    new XAI(context),
    new Gemini(context, options.endpoints?.gemini),
  ];
  const gateway = new Gateway({
    cpa: () => cpa.client,
    connectors,
    catalogPath: join(stateDir, "models.json"),
  });
  const attach = async (): Promise<void> => {
    models.attach({ baseUrl: cpa.baseUrl, key: cpa.accessKey });
    // Sessions that resume at startup name models of this provider, so the catalog is in
    // before the host serves anything.
    try {
      await models.update(await gateway.models());
    } catch (error) {
      warn(`[eta] llm: could not read the model catalog: ${String(error)}`);
    }
  };
  await attach();
  cpa.onMoved(() => void attach());

  const keys = new AgentKeys();
  return {
    gateway,
    origin: `${options.hostOrigin}${LLM_ROUTE.slice(0, -1)}`,
    scopedKey: (agentId) => keys.of(agentId),
    revoke: async (agentId) => keys.revoke(agentId),
    close: () => cpa.stop(),
    async forward(request) {
      const url = new URL(request.url);
      const path = url.pathname.slice(LLM_ROUTE.length - 1);
      const bearer = /^Bearer (.+)$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      // Only an agent's key, and only /v1.
      if (!path.startsWith("/v1/") || keys.scopeOf(bearer ?? "") === undefined)
        return new Response("unauthorized", { status: 401 });
      const headers = new Headers({ authorization: `Bearer ${cpa.accessKey}` });
      for (const name of ["content-type", "accept"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const answer = await fetch(
        `${new URL(cpa.baseUrl).origin}${path}${url.search}`,
        {
          method: request.method,
          headers,
          body: request.body,
          signal: request.signal,
        },
      );
      return new Response(answer.body, {
        status: answer.status,
        headers: { "content-type": answer.headers.get("content-type") ?? "" },
      });
    },
  };
}
