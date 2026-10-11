import { z } from "zod";

export const DESCRIPTION_MAX = 10_000;

// One schema for create and edit; new agent settings become new fields here.
export const agentFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "请输入名称。")
    .max(100, "名称最多 100 个字符。"),
  description: z
    .string()
    .max(
      DESCRIPTION_MAX,
      `指令最多 ${DESCRIPTION_MAX.toLocaleString()} 个字符。`,
    ),
  // "" until a model is chosen.
  model: z.string(),
  // null: every built-in bundle, the default for new agents.
  bundles: z.array(z.string()).nullable(),
});
export type AgentForm = z.infer<typeof agentFormSchema>;

/** The request's fields: the model and bundles only once chosen. */
export function agentDraft({ model, bundles, ...fields }: AgentForm) {
  return {
    ...fields,
    ...(model ? { model } : {}),
    ...(bundles ? { bundles } : {}),
  };
}
