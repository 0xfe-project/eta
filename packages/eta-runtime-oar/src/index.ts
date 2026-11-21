/**
 * Claude Code, Codex, OpenCode and Pi as runtimes an eta session can run on, through oar.
 *
 * `createOarRuntimes` is what a session host is given (`SessionRuntimes`): for a session whose
 * metadata names one of these runtimes it opens a delegate that takes the session's runs, and the
 * runtime's catalog as the session's model layer. `catalog` is the same answer a settings screen
 * reads: which runtimes this machine has, their models, and what a session on each would take.
 *
 * Each runtime's adapter is loaded when it is first wanted (a session on it, a settings screen that
 * lists it), from its own oar entry: an idle host has none of them loaded.
 */
import type { RuntimeRegistry } from "@botiverse/oar/browser";
import type {
  SessionRuntime,
  SessionRuntimeInput,
  SessionRuntimes,
} from "@eta/server";
import { isRuntimeId, RuntimeCatalog } from "./catalog";
import { OarDelegate } from "./delegate";
import { runtimeModels } from "./models";

export {
  isRuntimeId,
  RUNTIME_IDS,
  type RuntimeId,
  type RuntimeInfo,
  type RuntimeModel,
} from "./catalog";
export { effortFor } from "./models";

export interface OarRuntimes extends SessionRuntimes {
  readonly catalog: RuntimeCatalog;
}

export interface OarRuntimesOptions {
  /**
   * The runtimes to reach (a test hands in scripted ones); by default oar's, each loaded from its
   * own entry when first wanted.
   */
  registry?: RuntimeRegistry;
  warn?: (message: string) => void;
}

export function createOarRuntimes(
  options: OarRuntimesOptions = {},
): OarRuntimes {
  const catalog = new RuntimeCatalog(
    options.registry === undefined ? {} : { registry: options.registry },
  );
  const warn = options.warn ?? (() => undefined);
  return {
    catalog,
    open: (input: SessionRuntimeInput): SessionRuntime | undefined => {
      if (!isRuntimeId(input.runtime)) return undefined;
      // The first look at a runtime fills the catalog the model lookups read: that runtime's
      // entry alone, so a session on one runtime loads no other.
      if (catalog.peek(input.runtime) === undefined)
        void catalog.info(input.runtime);
      const delegate = new OarDelegate({
        runtime: input.runtime,
        catalog,
        sessionId: input.sessionId,
        cwd: input.cwd,
        resume: input.resume,
        agentPrompt: input.agentPrompt,
        remember: input.remember,
        hostTools: input.hostTools,
        mcpServers: input.mcpServers,
        launchArgs: input.launchArgs,
        wake: input.wake,
        warn,
      });
      return {
        models: runtimeModels(input.runtime, catalog),
        delegate,
        compact: async (config) => await delegate.compact(config),
        capabilities: async () => await delegate.capabilities(),
        residency: () => delegate.residency(),
        release: async () => await delegate.release(),
        dispose: async () => await delegate.dispose(),
      };
    },
  };
}
