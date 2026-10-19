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

export interface LlmOptions {
  /** Merged over CPA's generated config: how a test points an upstream at a fake server. */
  cpaExtra?: Record<string, unknown> | undefined;
}

export interface LlmRuntime {
  readonly client: GatewayClient;
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
      return { client, close: gateway.stop };
    }
    await Bun.sleep(50);
  }
  try {
    await models.update(await client.models());
  } catch (error) {
    warn(`[eta] llm: could not read the model catalog: ${String(error)}`);
  }
  return { client, close: gateway.stop };
}
