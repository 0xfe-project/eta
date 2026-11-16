import type {
  AgentFields,
  AgentRuntime,
  ThinkingLevel,
} from "@eta/client-contracts";
import { isAgentRuntime } from "@eta/client-contracts";
import { z } from "zod";
import { formatLocale, translate } from "@/lib/i18n";

export const DESCRIPTION_MAX = 10_000;

/**
 * What can answer for an agent: eta's own loop, an oar runtime (Claude Code, Codex, OpenCode, Pi),
 * or an external ACP agent configured on the host, `acp.<id>`. The ACP ones come only from the
 * host's list (`agents.runtimes`); none is named here.
 */
// One schema for create and edit; new agent settings become new fields here.
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { error: () => translate("validation:nameRequired") })
    .max(100, { error: () => translate("validation:nameMaxLength") }),
  description: z.string().max(DESCRIPTION_MAX, {
    error: () =>
      translate("validation:instructionsMaxLength", {
        maxCharacters: DESCRIPTION_MAX.toLocaleString(formatLocale()),
      }),
  }),
  // Which persona card the agent wears; "" is the project's default, which is a card too.
  persona: z.string().max(200),
  // What answers for it: eta's own loop, or an external runtime on the machine.
  runtime: z.custom<AgentRuntime>(
    (value) => typeof value === "string" && isAgentRuntime(value),
  ),
  // "" until a model is chosen; on an external runtime, "" is the runtime's default.
  model: z.string(),
  // "" leaves it to the model's own default.
  thinkingLevel: z.string(),
  // The machine it runs on; "" follows the project's.
  machineId: z.string(),
  // The plugins it has enabled.
  plugins: z.array(z.string()),
});
export type AgentForm = z.infer<typeof agentFormSchema>;

/**
 * The request's fields. Every field rides along: `persona` "" is a real value ("the project's
 * default card"), and a model or thinking level left empty is `null`, which clears it.
 */
export function agentDraft({
  description,
  model,
  persona,
  runtime,
  thinkingLevel,
  name,
  machineId,
  plugins,
}: AgentForm): AgentFields {
  return {
    name,
    instructions: description,
    persona,
    runtime,
    model: model || null,
    thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
    machineId: machineId || null,
    plugins,
  };
}

/**
 * Why `name` cannot be given to an agent, as the host would refuse it: Captain's own name
 * (`reserved`), or another agent's (`taken`), compared without case. `except` is the agent being
 * edited: keeping the name it has is never refused, so a user agent called "Captain" from before
 * the name was reserved can still be saved.
 */
export function agentNameProblem(
  agents: readonly { id: string; name: string }[],
  name: string,
  except?: string,
): "reserved" | "taken" | undefined {
  const wanted = name.trim().toLowerCase();
  const own = agents.find((agent) => agent.id === except);
  if (own !== undefined && own.name.trim().toLowerCase() === wanted)
    return undefined;
  if (wanted === "captain") return "reserved";
  return agents.some(
    (agent) =>
      agent.id !== except && agent.name.trim().toLowerCase() === wanted,
  )
    ? "taken"
    : undefined;
}
