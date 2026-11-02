import type { AgentFields, ThinkingLevel } from "@eta/client-contracts";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { z } from "zod";
import { formatLocale, translate } from "@/lib/i18n";

export const DESCRIPTION_MAX = 10_000;

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
  runtime: z.enum(AGENT_RUNTIMES),
  // "" until a model is chosen; on an external runtime, "" is the runtime's default.
  model: z.string(),
  // "" leaves it to the model's own default.
  thinkingLevel: z.string(),
  // The bundles it loads. Only the editor sets them; a form without them leaves them alone.
  bundles: z.array(z.string()).optional(),
  // The machine it runs on; "" follows the project's.
  machineId: z.string(),
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
  bundles,
  machineId,
}: AgentForm): AgentFields {
  return {
    name,
    instructions: description,
    persona,
    runtime,
    model: model || null,
    thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
    machineId: machineId || null,
    ...(bundles === undefined ? {} : { bundles }),
  };
}
