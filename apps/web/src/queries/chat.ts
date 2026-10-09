import type { QueryClient } from "@tanstack/react-query";
import type {
  ActivityBlock,
  Agent,
  AgentDeleted,
  AgentUpdated,
  Snapshot as ChatSnapshot,
  Interaction,
  InteractionUpdated,
  Message,
  MessageUpdated,
  Plugin,
  Sent,
  TextBlock,
} from "@/api/control-plane.gen";
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { ApiError, controlPlane, unwrap } from "@/lib/api";
import { refreshLlm } from "@/queries/llm";

// The control plane's chat API; every type comes from its OpenAPI document.

export type { Agent, Interaction, Plugin };
/** Editable agent fields; grows as agents gain settings. */
export type AgentDraft = Pick<Agent, "name" | "description"> & {
  model?: string;
  // Every plugin when left out.
  plugins?: string[];
};
export type ChatMessage = Message;
export type Block = TextBlock | ActivityBlock;
/**
 * The snapshot plus `messages`: every message seen since it was taken (over
 * SSE or from our own writes), starting with the active replies. History
 * pages fill in the rest; see useAgentMessages.
 */
type Snapshot = ChatSnapshot & { messages: ChatMessage[] };

export const ACTIVE_STATUSES = new Set<ChatMessage["status"]>([
  "queued",
  "responding",
  "waiting_for_input",
  "stopping",
]);

const chatKey = ["chat"] as const;

// Browser-only: relative /api URLs go through the dev proxy.
export function chatQueryOptions() {
  return queryOptions({
    queryKey: chatKey,
    queryFn: async ({ signal }) => {
      const snapshot = await unwrap(
        controlPlane.GET("/api/v1/chat", { signal }),
      );
      return {
        ...snapshot,
        messages: sortMessages([...snapshot.active_replies]),
      };
    },
    // Live updates arrive over SSE; refetching would only reset the stream.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

function upsert<T extends { id: string; revision: number }>(
  items: T[],
  item: T,
) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  if (items[index].revision >= item.revision) return items;
  return items.map((existing, i) => (i === index ? item : existing));
}

// Send order; a reply sorts after its user message.
function sortMessages(messages: ChatMessage[]) {
  return messages.sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      (a.role === b.role ? 0 : a.role === "user" ? -1 : 1),
  );
}

function upsertMessage(snapshot: Snapshot, message: ChatMessage): Snapshot {
  const messages = upsert(snapshot.messages, message);
  if (messages === snapshot.messages) return snapshot;
  return { ...snapshot, messages: sortMessages(messages) };
}

function removeAgent(snapshot: Snapshot, agentId: string): Snapshot {
  return {
    ...snapshot,
    agents: snapshot.agents.filter((agent) => agent.id !== agentId),
  };
}

function update(queryClient: QueryClient, apply: (s: Snapshot) => Snapshot) {
  queryClient.setQueryData<Snapshot>(chatKey, (snapshot) =>
    snapshot ? apply(snapshot) : snapshot,
  );
}

function applyEvent(queryClient: QueryClient, type: string, data: unknown) {
  if (type === "agent.updated") {
    const { agent } = data as AgentUpdated;
    update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) }));
  } else if (type === "agent.deleted") {
    const { agent_id } = data as AgentDeleted;
    update(queryClient, (s) => removeAgent(s, agent_id));
  } else if (type === "message.updated") {
    const { message } = data as MessageUpdated;
    update(queryClient, (s) => upsertMessage(s, message));
  } else if (type === "interaction.updated") {
    const { interaction } = data as InteractionUpdated;
    update(queryClient, (s) => ({
      ...s,
      interactions: upsert(s.interactions, interaction),
    }));
  }
}

/** Whether the stream dropped and has not come back yet. */
export const useStreamLost = create<{ lost: boolean }>(() => ({ lost: false }));

/** Subscribe to product events from the snapshot's cursor. */
function useChatStream(cursor: string | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!cursor) return;
    const source = new EventSource(
      `/api/v1/chat/stream?cursor=${encodeURIComponent(cursor)}`,
    );
    const types = [
      "agent.updated",
      "agent.deleted",
      "message.updated",
      "interaction.updated",
    ];
    const listener = (event: MessageEvent) =>
      applyEvent(queryClient, event.type, JSON.parse(event.data));
    types.forEach((type) => source.addEventListener(type, listener));
    source.onopen = () => useStreamLost.setState({ lost: false });
    // EventSource resumes by itself with Last-Event-ID. Once it gives up
    // (e.g. an expired cursor), reload the snapshot for a fresh cursor.
    source.onerror = () => {
      useStreamLost.setState({ lost: true });
      if (source.readyState === EventSource.CLOSED)
        void queryClient.invalidateQueries({ queryKey: chatKey });
    };
    return () => {
      types.forEach((type) => source.removeEventListener(type, listener));
      source.close();
    };
  }, [cursor, queryClient]);
}

export function useChat() {
  const query = useQuery(chatQueryOptions());
  useChatStream(query.data?.event_cursor);
  return query;
}

/** Every agent's interactions waiting for the user. */
export function usePendingInteractions() {
  const { data } = useQuery(chatQueryOptions());
  return (data?.interactions ?? []).filter(
    (interaction) => interaction.status === "pending",
  );
}

/**
 * Every agent's latest confirmations, answered or not, newest first: the
 * fetched list, kept live by the snapshot's interactions from the stream.
 */
export function useInteractionHistory() {
  const { data: snapshot } = useQuery(chatQueryOptions());
  const query = useQuery({
    // Under chatKey, so reloading the snapshot reloads the list with it.
    queryKey: [...chatKey, "interactions"],
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          controlPlane.GET("/api/v1/chat/interactions", {
            params: { query: { limit: 100 } },
            signal,
          }),
        )
      ).interactions,
  });
  const byId = new Map((query.data ?? []).map((i) => [i.id, i]));
  for (const live of snapshot?.interactions ?? []) {
    const known = byId.get(live.id);
    if (!known || live.revision > known.revision) byId.set(live.id, live);
  }
  const interactions = [...byId.values()].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  return { ...query, interactions };
}

// Under chatKey, so reloading the snapshot reloads history with it.
function messagesQueryOptions(agentId: string) {
  return infiniteQueryOptions({
    queryKey: [...chatKey, "messages", agentId],
    queryFn: async ({ pageParam, signal }) => {
      return unwrap(
        controlPlane.GET("/api/v1/agents/{agent_id}/messages", {
          params: {
            path: { agent_id: agentId },
            query: pageParam ? { before: pageParam } : {},
          },
          signal,
        }),
      );
    },
    initialPageParam: null as string | null,
    // Pages go back in time; the "next" page is the older one.
    getNextPageParam: (page) => page.next_cursor,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * One agent's timeline: history pages merged with the messages seen since
 * the snapshot, by revision.
 */
export function useAgentMessages(agentId: string | undefined) {
  const { data: snapshot } = useQuery(chatQueryOptions());
  // History read after the snapshot leaves no gap before the live messages.
  const history = useInfiniteQuery({
    ...messagesQueryOptions(agentId ?? ""),
    enabled: Boolean(agentId && snapshot),
  });
  const pages = history.data?.pages;
  const live = snapshot?.messages;
  const messages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const page of pages ?? [])
      for (const message of page.items) byId.set(message.id, message);
    for (const message of live ?? []) {
      if (message.agent_id !== agentId) continue;
      const known = byId.get(message.id);
      if (!known || known.revision < message.revision)
        byId.set(message.id, message);
    }
    return sortMessages([...byId.values()]);
  }, [agentId, live, pages]);
  return {
    messages,
    loading: history.isPending && Boolean(agentId),
    error: history.error,
    hasOlder: history.hasNextPage,
    loadingOlder: history.isFetchingNextPage,
    loadOlder: history.fetchNextPage,
  };
}

/** The runtime image's plugins agents choose from; fixed per deploy. */
export function usePlugins() {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: async ({ signal }) =>
      unwrap(controlPlane.GET("/api/v1/plugins", { signal })),
    staleTime: Infinity,
  });
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: AgentDraft) =>
      unwrap(controlPlane.POST("/api/v1/agents", { body: draft })),
    onSuccess: (agent) =>
      update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) })),
  });
}

/** "queue" waits for the agent's current reply; "steer" joins it. */
export type SendMode = "queue" | "steer";
export function addSent(queryClient: QueryClient, sent: Sent) {
  update(queryClient, (s) =>
    upsertMessage(upsertMessage(s, sent.message), sent.reply),
  );
}

/** A one-off send; the chat's composer sends through the outbox instead. */
export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      agentId: string;
      text: string;
      mode?: SendMode;
    }) =>
      unwrap(
        controlPlane.POST("/api/v1/chat/messages", {
          body: {
            agent_id: input.agentId,
            text: input.text,
            mode: input.mode ?? "queue",
          },
        }),
      ),
    onSuccess: (sent) => addSent(queryClient, sent),
    // The model became unusable since the catalog was last loaded.
    onError: (error) => {
      if (error instanceof ApiError && error.code.startsWith("MODEL_"))
        void refreshLlm(queryClient);
    },
  });
}

/** Compact the agent's context; shows as a `/compact` turn. */
export function useCompact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) =>
      unwrap(
        controlPlane.POST("/api/v1/agents/{agent_id}/compact", {
          params: { path: { agent_id: agentId } },
        }),
      ),
    onSuccess: (sent) => addSent(queryClient, sent),
  });
}

export function useStopReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (replyId: string) =>
      unwrap(
        controlPlane.POST("/api/v1/chat/messages/{message_id}/stop", {
          params: { path: { message_id: replyId } },
        }),
      ),
    onSuccess: (message) =>
      update(queryClient, (s) => upsertMessage(s, message)),
  });
}

export function useAnswerInteraction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; value: string }) =>
      unwrap(
        controlPlane.POST("/api/v1/chat/interactions/{interaction_id}/answer", {
          params: { path: { interaction_id: input.id } },
          body: { value: input.value },
        }),
      ),
    onSuccess: (interaction) =>
      update(queryClient, (s) => ({
        ...s,
        interactions: upsert(s.interactions, interaction),
      })),
  });
}

export function useUpdateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...changes
    }: { id: string } & Partial<AgentDraft>) =>
      unwrap(
        controlPlane.PATCH("/api/v1/agents/{agent_id}", {
          params: { path: { agent_id: id } },
          body: changes,
        }),
      ),
    onSuccess: (agent) =>
      update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) })),
  });
}

/** Stop the agent's work and runtime; the next message starts a fresh one. */
export function useRestartAgent() {
  return useMutation({
    mutationFn: (id: string) =>
      unwrap(
        controlPlane.POST("/api/v1/agents/{agent_id}/restart", {
          params: { path: { agent_id: id } },
        }),
      ),
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await unwrap(
        controlPlane.DELETE("/api/v1/agents/{agent_id}", {
          params: { path: { agent_id: id } },
        }),
      );
      return id;
    },
    onSuccess: (id) => update(queryClient, (s) => removeAgent(s, id)),
  });
}
