import type {
  MemoryArgs,
  MemoryResults,
  MemorySource,
  MemoryView,
} from "@eta/client-contracts";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getWire } from "@/lib/wire";
import { useWireState } from "@/queries/wire";

// What the agents remember: the `memory` target. It is calls with no state of its own (the
// sidecar is the store), so the lists are queries over `memory.list` and are refetched after a
// change here, and now and then because turns are remembered in the background once they finish.

export type { MemorySource, MemoryView };

const keys = {
  agent: (agentId: string) => ["memory", agentId] as const,
  memories: (
    agentId: string,
    query: string,
    source?: MemorySource,
    conversationId?: string,
  ) =>
    [
      "memory",
      agentId,
      query,
      ...(source ? [source] : []),
      ...(conversationId ? [{ conversationId }] : []),
    ] as const,
};

const POLL_MS = 15_000;

/**
 * Whether this host runs with a memory sidecar. The target exists only then, so a host without one
 * hides the page rather than offering one that cannot load.
 */
export function useMemoryMounted(): boolean {
  return useWireState((state) =>
    state.mounted.some(
      (plugin) => plugin.name === "memory" && plugin.error === undefined,
    ),
  );
}

/** The agent's memories, newest first, or the ones matching `query`. */
function memoriesQueryOptions(
  agentId: string,
  query: string,
  source?: MemorySource,
  conversationId?: string,
) {
  return queryOptions({
    queryKey: keys.memories(agentId, query, source, conversationId),
    queryFn: async () => {
      const args: MemoryArgs["list"] = {
        agentId,
        ...(query ? { query } : {}),
        ...(source ? { source } : {}),
        ...(conversationId ? { conversationId } : {}),
      };
      const { memories } = await getWire().call<MemoryResults["list"]>(
        "memory",
        "list",
        args,
      );
      return memories;
    },
    refetchInterval: query ? false : POLL_MS,
  });
}

export function useMemories(
  agentId: string | undefined,
  query: string,
  source?: MemorySource,
  conversationId?: string,
) {
  return useQuery({
    ...memoriesQueryOptions(agentId ?? "", query, source, conversationId),
    enabled: Boolean(agentId),
  });
}

export function useRemember(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) =>
      getWire().call<MemoryResults["remember"]>("memory", "remember", {
        agentId,
        text,
      } satisfies MemoryArgs["remember"]),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: keys.agent(agentId) }),
  });
}

export function useForget(agentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      getWire().call<MemoryResults["forget"]>("memory", "forget", {
        agentId,
        id,
      } satisfies MemoryArgs["forget"]),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: keys.agent(agentId) }),
  });
}
