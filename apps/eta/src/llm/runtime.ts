/**
 * The gateway inside the host: CPA started, the account and catalog reader over it, and the model
 * layer's view of it.
 *
 * The host's model layer calls CPA's `/v1` directly, with CPA's key; nothing outside this process
 * knows that key.
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
import { XAI } from "./xai";

export interface LlmOptions {
  /** Merged over CPA's generated config: how a test points an upstream at a fake server. */
  cpaExtra?: CpaConfig | undefined;
  /** Where the connectors log in and check keys; tests point them at fakes. */
  endpoints?: { codexIssuer?: string; gemini?: string } | undefined;
}

export interface LlmRuntime {
  readonly gateway: Gateway;
  /** Stop CPA. */
  close: () => Promise<void>;
}

/**
 * Start the gateway under the data directory and point the model layer at it. Resolves with
 * nothing when CPA cannot start; the reason goes to `warn`.
 */
export async function openLlm(
  options: LlmOptions & {
    dataDir: string;
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
  // A CPA started again listens somewhere else.
  cpa.onRestarted(() => void attach());

  return {
    gateway,
    close: () => cpa.stop(),
  };
}
