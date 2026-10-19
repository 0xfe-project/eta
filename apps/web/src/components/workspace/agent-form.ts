import type { AgentFields, ThinkingLevel } from "@eta/client-contracts";
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
  // "" until a model is chosen.
  model: z.string(),
  // "" leaves it to the model's own default.
  thinkingLevel: z.string(),
  // The bundles it loads. Only the editor sets them; a form without them leaves them alone.
  bundles: z.array(z.string()).optional(),
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
  thinkingLevel,
  name,
  bundles,
}: AgentForm): AgentFields {
  return {
    name,
    instructions: description,
    persona,
    model: model || null,
    thinkingLevel: (thinkingLevel || null) as ThinkingLevel | null,
    ...(bundles === undefined ? {} : { bundles }),
  };
}
