// What decides whether the first-time setup opens by itself, and the facts it reads off the wire.
// The preselected model and the "one agent per card" rule follow apps/web/src/pages/onboard.tsx.

import type {
  AgentView,
  LlmAccounts,
  LlmModel,
  ProvidersView,
} from "@eta/client-contracts";
import type { Locale } from "../../config/types";
import type { WireClient, WireState } from "../../connection/types";
import type { Model } from "../kit/models";
import { LLM_PROVIDER_ID } from "@eta/client-contracts";
import { ordinaryAgents } from "../kit/captain";
import { buildModels, usableModels } from "../kit/models";

/** A persona card as the `personas` target lists it. */
export interface PersonaCardSummary {
  id: string;
  name: string;
  description: string;
  custom: boolean;
}

export interface SetupFacts {
  models: Model[];
  agents: AgentView[];
}

/** The setup is offered when no model can be used or no agent exists. */
export function needsSetup(facts: SetupFacts): boolean {
  return usableModels(facts.models).length === 0 || facts.agents.length === 0;
}

/**
 * The model new agents get: the last one used, else the first usable one. The TUI keeps no memory
 * of its own, so "last used" is the model of the newest agent on eta's own loop that names a
 * usable one.
 */
export function preferredModel(
  models: readonly Model[],
  agents: readonly AgentView[] = [],
): Model | undefined {
  const usable = usableModels(models);
  const newest = [...agents]
    .filter((agent) => agent.runtime === "eta" && agent.model !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const agent of newest) {
    const used = usable.find((model) => model.id === agent.model);
    if (used !== undefined) return used;
  }
  return usable[0];
}

/** The cards that already have an agent wearing them. */
export function cardsWithAgents(agents: readonly AgentView[]): Set<string> {
  return new Set(agents.map((agent) => agent.persona).filter(Boolean));
}

function gatewayMounted(state: WireState): boolean {
  const plugin = state.mounted.find((entry) => entry.name === LLM_PROVIDER_ID);
  return plugin !== undefined && plugin.error === undefined;
}

/**
 * A target's sections when the copy follows the host (see `TargetState.version`); undefined for
 * a copy that came with `hello` or outlived its last reader, which can be any age.
 */
function followed(
  state: WireState,
  target: string,
): Record<string, unknown> | undefined {
  const held = state.targets[target];
  return held !== undefined && held.version > 0 ? held.sections : undefined;
}

/** The facts once everything they need has come; undefined while something is missing. */
function factsOf(state: WireState, locale: Locale): SetupFacts | undefined {
  const providers = followed(state, "providers")?.config as
    | ProvidersView
    | undefined;
  const cards = followed(state, "personas")?.cards;
  const list = followed(state, "agents")?.list as AgentView[] | undefined;
  if (providers === undefined || cards === undefined || list === undefined)
    return undefined;
  const agents = ordinaryAgents(list);
  if (!gatewayMounted(state))
    return {
      models: buildModels({ providers, llm: undefined, locale }) ?? [],
      agents,
    };
  const llm = followed(state, LLM_PROVIDER_ID);
  const accounts = llm?.accounts as LlmAccounts | undefined;
  if (accounts?.ready !== true) return undefined;
  const models =
    buildModels({
      providers,
      llm: { accounts, models: llm?.models as LlmModel[] | undefined },
      locale,
    }) ?? [];
  return { models, agents };
}

/**
 * Holds `targets` and waits until `read` returns something for the wire's state; undefined when
 * it has not within `timeoutMs`. The targets are released either way.
 */
async function waitOnTargets<T>(
  wire: WireClient,
  targets: readonly string[],
  read: (state: WireState) => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const releases = targets.map((target) => wire.subscribe(target));
  let stopListening = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const check = (state: WireState) => {
        const found = read(state);
        if (found !== undefined) resolve(found);
      };
      stopListening = wire.store.subscribe(check);
      timer = setTimeout(resolve, timeoutMs, undefined);
      check(wire.store.getState());
    });
  } finally {
    clearTimeout(timer);
    stopListening();
    for (const release of releases) release();
  }
}

/**
 * The providers' config, the gateway's accounts once ready (when the host has a gateway), the
 * persona cards and the agents, each from a copy that follows the host; a copy nobody keeps up to
 * date (see `TargetState.version`) is not taken. Undefined when they have not all come within
 * `timeoutMs`.
 */
export async function readSetupFacts(
  wire: WireClient,
  locale: Locale,
  timeoutMs: number,
): Promise<SetupFacts | undefined> {
  const targets = ["providers", "personas", "agents"];
  if (gatewayMounted(wire.store.getState())) targets.push(LLM_PROVIDER_ID);
  return waitOnTargets(
    wire,
    targets,
    (state) => factsOf(state, locale),
    timeoutMs,
  );
}

/**
 * The host's agents from a copy that follows the host; a copy nobody keeps up to date is not
 * taken. Undefined when the list has not come within `timeoutMs`.
 */
export async function readAgentsNow(
  wire: WireClient,
  timeoutMs: number,
): Promise<AgentView[] | undefined> {
  return waitOnTargets(
    wire,
    ["agents"],
    (state) => {
      const list = followed(state, "agents")?.list as AgentView[] | undefined;
      return list === undefined ? undefined : ordinaryAgents(list);
    },
    timeoutMs,
  );
}
