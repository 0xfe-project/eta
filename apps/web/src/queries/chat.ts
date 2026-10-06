import { useEffect } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["idle", "working", "waiting_for_input", "unavailable"]),
  revision: z.number(),
});

const blockSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string(), type: z.literal("text"), text: z.string() }),
  z.object({
    id: z.string(),
    type: z.literal("activity"),
    label: z.string(),
    status: z.enum(["running", "completed", "failed"]),
  }),
]);

const messageSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  role: z.enum(["user", "assistant"]),
  reply_to_id: z.string().nullable(),
  status: z.enum([
    "queued",
    "responding",
    "waiting_for_input",
    "stopping",
    "completed",
    "stopped",
    "failed",
  ]),
  revision: z.number(),
  blocks: z.array(blockSchema),
  failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  created_at: z.string(),
});

const interactionSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  kind: z.literal("choice"),
  prompt: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  status: z.enum(["pending", "submitted", "resolved", "expired"]),
  revision: z.number(),
});

const snapshotSchema = z.object({
  agents: z.array(agentSchema),
  messages: z.array(messageSchema),
  active_replies: z.array(messageSchema),
  interactions: z.array(interactionSchema),
  history_cursor: z.string().nullable(),
  event_cursor: z.string(),
});

export type Agent = z.infer<typeof agentSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Interaction = z.infer<typeof interactionSchema>;
type Snapshot = z.infer<typeof snapshotSchema>;

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
      const snapshot = snapshotSchema.parse(await apiGet("/chat", signal));
      // Active replies may be older than the newest page; merge them in.
      return snapshot.active_replies.reduce(upsertMessage, snapshot);
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

function upsertMessage(snapshot: Snapshot, message: ChatMessage): Snapshot {
  const messages = upsert(snapshot.messages, message);
  if (messages === snapshot.messages) return snapshot;
  // Keep the timeline in send order; a reply sorts after its user message.
  messages.sort(
    (a, b) =>
      a.created_at.localeCompare(b.created_at) ||
      (a.role === b.role ? 0 : a.role === "user" ? -1 : 1),
  );
  return { ...snapshot, messages };
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
    const { agent } = z.object({ agent: agentSchema }).parse(data);
    update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) }));
  } else if (type === "agent.deleted") {
    const { agent_id } = z.object({ agent_id: z.string() }).parse(data);
    update(queryClient, (s) => removeAgent(s, agent_id));
  } else if (type === "message.updated") {
    const { message } = z.object({ message: messageSchema }).parse(data);
    update(queryClient, (s) => upsertMessage(s, message));
  } else if (type === "interaction.updated") {
    const { interaction } = z
      .object({ interaction: interactionSchema })
      .parse(data);
    update(queryClient, (s) => ({
      ...s,
      interactions: upsert(s.interactions, interaction),
    }));
  }
}

/** Subscribe to product events from the snapshot's cursor. */
export function useChatStream(cursor: string | undefined) {
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
    // EventSource resumes by itself with Last-Event-ID. Once it gives up
    // (e.g. an expired cursor), reload the snapshot for a fresh cursor.
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED)
        void queryClient.invalidateQueries({ queryKey: chatKey });
    };
    return () => source.close();
  }, [cursor, queryClient]);
}

export function useChat() {
  const query = useQuery(chatQueryOptions());
  useChatStream(query.data?.event_cursor);
  return query;
}

export function useCreateAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) =>
      agentSchema.parse(await apiPost("/agents", { name })),
    onSuccess: (agent) =>
      update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) })),
  });
}

export function useSendMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { agentId: string; text: string }) =>
      z.object({ message: messageSchema, reply: messageSchema }).parse(
        await apiPost("/chat/messages", {
          agent_id: input.agentId,
          text: input.text,
        }),
      ),
    onSuccess: ({ message, reply }) =>
      update(queryClient, (s) =>
        upsertMessage(upsertMessage(s, message), reply),
      ),
  });
}

export function useStopReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (replyId: string) =>
      messageSchema.parse(await apiPost(`/chat/messages/${replyId}/stop`)),
    onSuccess: (message) =>
      update(queryClient, (s) => upsertMessage(s, message)),
  });
}

export function useAnswerInteraction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; value: string }) =>
      interactionSchema.parse(
        await apiPost(`/chat/interactions/${input.id}/answer`, {
          value: input.value,
        }),
      ),
    onSuccess: (interaction) =>
      update(queryClient, (s) => ({
        ...s,
        interactions: upsert(s.interactions, interaction),
      })),
  });
}

export function useRenameAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string }) =>
      agentSchema.parse(
        await apiPatch(`/agents/${input.id}`, { name: input.name }),
      ),
    onSuccess: (agent) =>
      update(queryClient, (s) => ({ ...s, agents: upsert(s.agents, agent) })),
  });
}

export function useDeleteAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/agents/${id}`);
      return id;
    },
    onSuccess: (id) => update(queryClient, (s) => removeAgent(s, id)),
  });
}
