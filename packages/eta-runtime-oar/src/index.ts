/**
 * Claude Code, Codex, OpenCode and Pi as runtimes an eta session can run on, through oar.
 *
 * `createOarRuntimes` is what a session host is given (`SessionRuntimes`): for a session whose
 * metadata names one of these runtimes it opens a delegate that takes the session's runs, and the
 * runtime's catalog as the session's model layer. `catalog` is the same answer a settings screen
 * reads: which runtimes this machine has, and their models.
 */
import type { RuntimeRegistry } from "@botiverse/oar";
import type {
  SessionRuntime,
  SessionRuntimeInput,
  SessionRuntimes,
} from "@eta/server";
import { defaultRuntimes } from "@botiverse/oar";
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
  /** The runtimes to reach; oar's built-in ones by default (a test hands in scripted ones). */
  registry?: RuntimeRegistry;
  warn?: (message: string) => void;
}

export function createOarRuntimes(
  options: OarRuntimesOptions = {},
): OarRuntimes {
  const catalog = new RuntimeCatalog({
    registry: options.registry ?? defaultRuntimes,
  });
  const warn = options.warn ?? (() => undefined);
  return {
    catalog,
    open: (input: SessionRuntimeInput): SessionRuntime | undefined => {
      if (!isRuntimeId(input.runtime)) return undefined;
      // The first look at a runtime fills the catalog the model lookups read.
      if (catalog.peek(input.runtime) === undefined) void catalog.list();
      const delegate = new OarDelegate({
        runtime: input.runtime,
        catalog,
        sessionId: input.sessionId,
        cwd: input.cwd,
        resume: input.resume,
        agentPrompt: input.agentPrompt,
        remember: input.remember,
        hostTools: input.hostTools,
        warn,
      });
      return {
        models: runtimeModels(input.runtime, catalog),
        delegate,
        compact: async (config) => await delegate.compact(config),
        dispose: async () => await delegate.dispose(),
      };
    },
  };
}
