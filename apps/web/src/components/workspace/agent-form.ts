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
  // null: every built-in bundle, the default for new agents.
  bundles: z.array(z.string()).nullable(),
});
export type AgentForm = z.infer<typeof agentFormSchema>;

/**
 * The request's fields. `persona` rides along unconditionally — "" is a real value ("the
 * project's default card"), not an omission. The model and bundles go only once chosen.
 */
export function agentDraft({ model, bundles, persona, ...fields }: AgentForm) {
  return {
    ...fields,
    persona,
    ...(model ? { model } : {}),
    ...(bundles ? { bundles } : {}),
  };
}
