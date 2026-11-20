/**
 * ACP (Agent Client Protocol) agents as runtimes an eta session can run on.
 *
 * `createAcpRuntimes` is what a session host is given (`SessionRuntimes`), beside oar's: every
 * agent in this machine's `~/.eta/acp.json` is a runtime `acp.<id>`. For a session whose metadata
 * names one, it opens a delegate that starts the agent as a stdio child and hands it the
 * session's runs. `catalog` is what a settings screen reads; `config` is the file.
 */
import type {
  SessionRuntime,
  SessionRuntimeInput,
  SessionRuntimes,
} from "@eta/server";
import { AcpCatalog } from "./catalog";
import { acpAgentId, AcpConfigFile, defaultAcpConfigPath } from "./config";
import { AcpDelegate } from "./delegate";
import { acpModels } from "./models";

export { AcpAdmin } from "./admin";
export type { AcpAdminOptions } from "./admin";
export { AcpCatalog } from "./catalog";
export {
  acpAgentId,
  AcpConfigError,
  AcpConfigFile,
  acpRuntimeId,
  checkAcpAgent,
  defaultAcpConfigPath,
} from "./config";

export interface AcpRuntimes extends SessionRuntimes {
  readonly catalog: AcpCatalog;
  readonly config: AcpConfigFile;
}

export interface AcpRuntimesOptions {
  /** The file that lists the agents; `~/.eta/acp.json` by default. */
  configPath?: string;
  warn?: (message: string) => void;
  /** How long a catalog answer is good for. */
  ttlMs?: number;
}

export function createAcpRuntimes(
  options: AcpRuntimesOptions = {},
): AcpRuntimes {
  const warn = options.warn ?? (() => undefined);
  const config = new AcpConfigFile(
    options.configPath ?? defaultAcpConfigPath(),
  );
  const catalog = new AcpCatalog({
    config,
    warn,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });
  return {
    catalog,
    config,
    open: (input: SessionRuntimeInput): SessionRuntime | undefined => {
      const id = acpAgentId(input.runtime);
      if (id === undefined) return undefined;
      const delegate = new AcpDelegate({
        runtime: input.runtime,
        // Read at each start: what the user changed holds from the next process on.
        agent: () => {
          const agent = config.get(id);
          if (agent === undefined)
            throw new Error(
              `runtime_unavailable: the ACP agent ${id} is not configured on this machine (${config.path})`,
            );
          return agent;
        },
        sessionId: input.sessionId,
        cwd: input.cwd,
        resume: input.resume,
        agentPrompt: input.agentPrompt,
        remember: input.remember,
        mcpServers: input.mcpServers,
        hostTools: input.hostTools,
        learn: (choices) => catalog.learn(id, choices),
        warn,
      });
      return {
        models: acpModels(input.runtime, () => catalog.models(id)),
        delegate,
        residency: () => delegate.residency(),
        release: async () => await delegate.release(),
        dispose: async () => await delegate.dispose(),
      };
    },
  };
}
