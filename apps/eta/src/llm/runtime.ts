/**
 * The gateway inside the host: the library loaded, a client for its account API, and the model
 * layer's view of it.
 *
 * A host without the library (it is built with Go, which not every machine has) runs without a
 * gateway: no `llm` target, no `llm` models, everything else as before.
 */
import type { GatewayModels } from "./models";
import { join } from "node:path";
import { gatewayBuilt, startGateway } from "@eta/llm-gateway";
import { GatewayClient } from "./client";
import { LLM_ROUTE } from "./route";

export interface LlmOptions {
  /** Merged over CPA's generated config: how a test points an upstream at a fake server. */
  cpaExtra?: Record<string, unknown> | undefined;
}

export interface LlmRuntime {
  readonly client: GatewayClient;
  /** Where sessions on the host's machine reach the gateway: `http://127.0.0.1:<port>`. */
  readonly origin: string;
  /** The `/v1`-only key of one agent (its id), for its sessions' tools. */
  scopedKey: (agentId: string) => string;
  /** End an agent's keys, when the agent is gone. */
  revoke: (agentId: string) => Promise<void>;
  /**
   * Serve a request a daemon's session made to `/llm/v1/...`: only a scoped key passes (the
   * gateway checks it), and only `/v1` is reachable. The body and the answer stream.
   */
  forward: (request: Request) => Promise<Response>;
  /** Stop the gateway. Blocks until it is down. */
  close: () => void;
}

/** How long the host waits for the gateway to load its credentials before serving without them. */
const READY_TIMEOUT_MS = 15_000;

/**
 * Start the gateway under the data directory and point the model layer at it. Resolves with
 * nothing when it cannot start; the reason goes to `warn`.
 */
export async function openLlm(
  options: LlmOptions & {
    dataDir: string;
    models: GatewayModels;
    warn: (message: string) => void;
  },
): Promise<LlmRuntime | undefined> {
  const { warn, models } = options;
  if (!gatewayBuilt()) {
    warn(
      "[eta] llm: the gateway library is not built, so no subscriptions or Gemini keys " +
        "(bun run --cwd packages/llm-gateway build; needs Go)",
    );
    return undefined;
  }
  let gateway: ReturnType<typeof startGateway>;
  try {
    gateway = startGateway({
      stateDir: join(options.dataDir, "llm"),
      cpaExtra: options.cpaExtra,
    });
  } catch (error) {
    warn(`[eta] llm: the gateway did not start: ${String(error)}`);
    return undefined;
  }
  const client = new GatewayClient(gateway);
  models.attach({ baseUrl: gateway.baseUrl, key: gateway.key });
  // Sessions that resume at startup name models of this provider, so the catalog is in before
  // the host serves anything, unless the gateway is slow to load: then it follows (the plugin
  // keeps reading) and those sessions find their model a moment later.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!(await client.ready())) {
    if (Date.now() > deadline) {
      warn(
        "[eta] llm: the gateway is slow to load its credentials; serving without them",
      );
      return runtimeOf(gateway, client);
    }
    await Bun.sleep(50);
  }
  try {
    await models.update(await client.models());
  } catch (error) {
    warn(`[eta] llm: could not read the model catalog: ${String(error)}`);
  }
  return runtimeOf(gateway, client);
}

/** What the other parts of the host get of a started gateway. */
function runtimeOf(
  gateway: ReturnType<typeof startGateway>,
  client: GatewayClient,
): LlmRuntime {
  return {
    client,
    close: gateway.stop,
    origin: gateway.origin,
    scopedKey: gateway.scopedKey,
    revoke: gateway.revoke,
    async forward(request) {
      const url = new URL(request.url);
      const path = url.pathname.slice(LLM_ROUTE.length - 1);
      const credential = request.headers.get("authorization") ?? "";
      // Only an agent's scoped key, and only /v1: the host's own key must not work from outside,
      // even if it leaked this far.
      if (!path.startsWith("/v1/") || !credential.startsWith("Bearer etak."))
        return new Response("unauthorized", { status: 401 });
      const headers = new Headers();
      for (const name of ["authorization", "content-type", "accept"]) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      const answer = await fetch(`${gateway.origin}${path}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
      });
      return new Response(answer.body, {
        status: answer.status,
        headers: { "content-type": answer.headers.get("content-type") ?? "" },
      });
    },
  };
}
