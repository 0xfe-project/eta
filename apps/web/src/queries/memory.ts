import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { memoryApi } from "@/lib/api";

// Agents' long-term memories (/api/bundles/memory/v1). See bundles/memory/service.

const memorySchema = z.object({
  id: z.string(),
  text: z.string(),
  source_group_id: z.string().optional(),
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
  memories: (
    agentId: string,
    query: string,
    source?: MemorySource,
    groupId?: string,
  ) =>
    [
      "memory",
      agentId,
      query,
      ...(source ? [source] : []),
      ...(groupId ? [{ groupId }] : []),
    ] as const,
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
  groupId?: string,
) {
  return queryOptions({
    queryKey: keys.memories(agentId, query, source, groupId),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      if (source) params.set("source", source);
      if (groupId) params.set("group_id", groupId);
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
  groupId?: string,
) {
  return useQuery({
    ...memoriesQueryOptions(agentId ?? "", query, source, groupId),
    enabled: Boolean(agentId),
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
