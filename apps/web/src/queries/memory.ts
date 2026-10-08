import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { memoryApi } from "@/lib/api";

// Agents' long-term memories (/api/memory/v1). See apps/memory-service.

const memorySchema = z.object({
  id: z.string(),
  text: z.string(),
  // Relevance, on search results only.
  score: z.number().optional(),
  created_at: z.string().optional(),
});

export type Memory = z.infer<typeof memorySchema>;

const keys = {
  agent: (agentId: string) => ["memory", agentId] as const,
  memories: (agentId: string, query: string) =>
    ["memory", agentId, query] as const,
};

const path = (agentId: string) =>
  `/agents/${encodeURIComponent(agentId)}/memories`;

// Turns are remembered in the background after they finish.
const POLL_MS = 15_000;

/** The agent's memories, newest first, or the ones matching ``query``. */
export function useMemories(agentId: string | undefined, query: string) {
  return useQuery({
    queryKey: keys.memories(agentId ?? "", query),
    enabled: Boolean(agentId),
    queryFn: async ({ signal }) => {
      const search = query ? `?q=${encodeURIComponent(query)}` : "";
      const body = await memoryApi.get(`${path(agentId!)}${search}`, signal);
      return z.array(memorySchema).parse(body.memories);
    },
    refetchInterval: query ? false : POLL_MS,
    // Keeps the list while a search for the same agent loads.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === agentId ? previous : undefined,
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
