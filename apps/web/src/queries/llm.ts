import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { llmApi } from "@/lib/api";

// What the models were used for, as the host counts it (/api/llm/v1/usage/agents). The providers,
// their models and signing in are the `providers` target on the wire: see queries/providers.ts.

const countsSchema = z.object({
  requests: z.number(),
  failed: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_tokens: z.number(),
  reasoning_tokens: z.number(),
  total_tokens: z.number(),
});

const agentUsageSchema = z.object({
  principal: z.string(),
  windows: z.record(z.string(), countsSchema),
  models: z.array(countsSchema.extend({ name: z.string() })),
  accounts: z.array(countsSchema.extend({ name: z.string() })),
});

/**
 * Who used the models over the last 5 hours, day and week: a chat agent
 * (its id; memory extraction for it counts too) or a routine ("routine-<id>").
 */
export function useAgentUsage(principal: string | undefined) {
  return useQuery({
    queryKey: ["llm", "usage", "agents"] as const,
    queryFn: async ({ signal }) =>
      z
        .object({ usage: z.array(agentUsageSchema) })
        .parse(await llmApi.get("/usage/agents", signal)).usage,
    select: (usage) => usage.find((u) => u.principal === principal),
    enabled: Boolean(principal),
    refetchInterval: 60_000,
  });
}
