/** What the host offers for an agent's keys, read once for the guide of its file. */
import type {
  AgentRuntimeInfo,
  AgentView,
  LlmAccounts,
  LlmModel,
  MachineView,
  PluginView,
  ProvidersView,
} from "@eta/client-contracts";
import type { ShellContext } from "../../extensions/types";
import type { AgentChoices } from "./guide";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { translatorFor } from "../../i18n/messages";
import { callErrorText } from "../kit/errors";
import { buildModels, usableModels } from "../kit/models";
import { readLive } from "./live";
import { agentMessages } from "./messages";

interface PersonaSummary {
  id: string;
  name: string;
}

async function sectionsOf(
  ctx: ShellContext,
  target: string,
  section: string,
): Promise<Record<string, unknown>> {
  return readLive(ctx.wire, target, {
    ready: (sections) => sections[section] !== undefined,
    failure: translatorFor(agentMessages, ctx.locale)("noState", { target }),
  });
}

async function etaModels(ctx: ShellContext): Promise<string[]> {
  const gateway = ctx.wire.store
    .getState()
    .mounted.find((plugin) => plugin.name === LLM_PROVIDER_ID);
  const [providers, llm] = await Promise.all([
    sectionsOf(ctx, "providers", "config"),
    gateway === undefined || gateway.error !== undefined
      ? undefined
      : sectionsOf(ctx, LLM_PROVIDER_ID, "models"),
  ]);
  const models = buildModels({
    providers: providers.config as ProvidersView,
    llm:
      llm === undefined
        ? undefined
        : {
            accounts: llm.accounts as LlmAccounts | undefined,
            models: llm.models as LlmModel[] | undefined,
          },
    locale: ctx.locale,
  });
  return usableModels(models ?? []).map((model) => model.id);
}

async function runtimeModels(
  ctx: ShellContext,
  agent: AgentView,
): Promise<Pick<AgentChoices, "runtimeModels" | "runtimeModelsError">> {
  try {
    const { runtimes } = await ctx.wire.call<{ runtimes: AgentRuntimeInfo[] }>(
      "agents",
      "runtimes",
      agent.machineId === null ? {} : { machineId: agent.machineId },
    );
    return {
      runtimeModels: runtimes
        .filter((runtime) => runtime.status === "available")
        .map((runtime) => ({
          runtime: runtime.id,
          models: runtime.models.map((model) => `${runtime.id}:${model.id}`),
        })),
      runtimeModelsError: undefined,
    };
  } catch (error) {
    return {
      runtimeModels: [],
      runtimeModelsError: callErrorText(error, ctx.locale),
    };
  }
}

/** A machine an agent can be pinned to, as the host checks it: the primary or a daemon let in. */
function canRunAgents(machine: MachineView): boolean {
  return (
    (machine.kind === "primary" || machine.kind === "daemon") &&
    machine.status !== "revoked" &&
    machine.status !== "pending"
  );
}

async function machineChoices(
  ctx: ShellContext,
): Promise<AgentChoices["machines"]> {
  const { list } = await sectionsOf(ctx, "machines", "list");
  return (list as MachineView[])
    .filter(canRunAgents)
    .map(({ id, name }) => ({ id, name }));
}

async function pluginChoices(
  ctx: ShellContext,
): Promise<AgentChoices["plugins"]> {
  const { list } = await sectionsOf(ctx, "plugins", "list");
  return (list as PluginView[]).map((plugin) => ({
    name: plugin.name,
    needsConfig: plugin.state === "needs_config" || plugin.problem !== null,
  }));
}

async function personaChoices(
  ctx: ShellContext,
): Promise<AgentChoices["personas"]> {
  const { cards } = await sectionsOf(ctx, "personas", "cards");
  return (cards as PersonaSummary[]).map(({ id, name }) => ({ id, name }));
}

/**
 * What the host offers for the agent's keys. A list that cannot be read is empty, and why is in
 * `unlisted`: the lists only feed the guide, so the export goes on without them.
 */
export async function readChoices(
  ctx: ShellContext,
  agent: AgentView,
): Promise<AgentChoices> {
  const unlisted: NonNullable<AgentChoices["unlisted"]> = {};
  const listed = async <T>(
    name: keyof typeof unlisted,
    read: Promise<readonly T[]>,
  ): Promise<readonly T[]> => {
    try {
      return await read;
    } catch (error) {
      unlisted[name] = error instanceof Error ? error.message : String(error);
      return [];
    }
  };
  const [models, runtimes, machines, plugins, personas] = await Promise.all([
    listed("models", etaModels(ctx)),
    runtimeModels(ctx, agent),
    listed("machines", machineChoices(ctx)),
    listed("plugins", pluginChoices(ctx)),
    listed("personas", personaChoices(ctx)),
  ]);
  return { models, ...runtimes, machines, plugins, personas, unlisted };
}
