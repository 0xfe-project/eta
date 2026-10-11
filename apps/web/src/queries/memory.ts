import {
  queryOptions,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { memoryApi } from "@/lib/api";

// Agents' long-term memories (/api/memory/v1). See apps/memory-service.

const memorySchema = z.object({
  id: z.string(),
  text: z.string(),
  // Relevance, on search results only.
  score: z.number().optional(),
  created_at: z.string().optional(),
  // Missing on memories from before sources were recorded.
  source: z.enum(["conversation", "agent", "user"]).optional(),
});

export type MemorySource = NonNullable<Memory["source"]>;

export type Memory = z.infer<typeof memorySchema>;

const keys = {
  agent: (agentId: string) => ["memory", agentId] as const,
  memories: (agentId: string, query: string, source?: MemorySource) =>
    source
      ? (["memory", agentId, query, source] as const)
      : (["memory", agentId, query] as const),
};

const path = (agentId: string) =>
  `/agents/${encodeURIComponent(agentId)}/memories`;

// Turns are remembered in the background after they finish.
const POLL_MS = 15_000;

/** The agent's memories, newest first, or the ones matching ``query``. */
function memoriesQueryOptions(
  agentId: string,
  query: string,
  source?: MemorySource,
) {
  return queryOptions({
    queryKey: keys.memories(agentId, query, source),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (source) params.set("source", source);
      const search = params.size ? `?${params}` : "";
      const body = await memoryApi.get(`${path(agentId)}${search}`, signal);
      return z.array(memorySchema).parse(body.memories);
    },
    refetchInterval: query ? false : POLL_MS,
  });
}

export function useMemories(
  agentId: string | undefined,
  query: string,
  source?: MemorySource,
) {
  return useQuery({
    ...memoriesQueryOptions(agentId ?? "", query, source),
    enabled: Boolean(agentId),
  });
}

/**
 * How many memories each agent has; undefined until every list loads. Shares
 * the memory tab's cache. The API has no count, so this reads whole lists.
 */
export function useMemoryCounts(agentIds: string[]) {
  return useQueries({
    queries: agentIds.map((id) => memoriesQueryOptions(id, "")),
    combine: (results) => ({
      byAgent: new Map(
        agentIds.map((id, i) => [id, results[i].data?.length] as const),
      ),
      total: results.every((result) => result.data)
        ? results.reduce((sum, result) => sum + result.data!.length, 0)
        : undefined,
    }),
  });
}

export function useRemember(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) =>
      memorySchema.parse(await memoryApi.post(path(agentId), { text })),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: keys.agent(agentId) }),
  });
}

export function useForget(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) =>
      memoryApi.delete(`${path(agentId)}/${encodeURIComponent(memoryId)}`),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: keys.agent(agentId) }),
  });
}
