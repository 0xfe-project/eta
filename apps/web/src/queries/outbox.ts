import type { QueryClient } from "@tanstack/react-query";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { SendMode } from "@/queries/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ApiError, controlPlane, unwrap } from "@/lib/api";
import { addSent } from "@/queries/chat";
import { refreshLlm } from "@/queries/llm";

// What the user has written and not yet seen arrive: a draft per agent, and
// the messages on their way to the control plane. A message has its id from
// the moment it is sent; every try carries it, as the message's id and as the
// Idempotency-Key, so trying again (after a lost response, a reload, a
// retry) is the same message, never a second one. Both survive a reload.

const outgoingSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().max(64),
  text: z.string().max(10000),
  mode: z.enum(["queue", "steer"]),
  /** Why it did not arrive; absent while it is being sent. */
  failure: z.string().max(500).optional(),
});
const savedSchema = z.object({
  drafts: z.record(z.string(), z.string().max(10000)),
  outgoing: z.array(outgoingSchema).max(100),
});

export type Outgoing = z.infer<typeof outgoingSchema>;
type Saved = z.infer<typeof savedSchema>;

interface OutboxStore extends Saved {
  setDraft: (agentId: string, text: string) => void;
  add: (outgoing: Outgoing) => void;
  update: (id: string, changes: Partial<Outgoing>) => void;
  remove: (id: string) => void;
}

const storage: PersistStorage<Saved> = {
  getItem: (name) => {
    try {
      const saved = localStorage.getItem(name);
      if (!saved) return null;
      const result = savedSchema.safeParse(JSON.parse(saved));
      return result.success ? { state: result.data } : null;
    } catch {
      return null; // Storage may be unavailable in private browsing.
    }
  },
  setItem: (name, value: StorageValue<Saved>) => {
    try {
      localStorage.setItem(name, JSON.stringify(value.state));
    } catch {
      // Kept in memory; only a reload loses it.
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

export const useOutbox = create<OutboxStore>()(
  persist(
    (set) => ({
      drafts: {},
      outgoing: [],
      setDraft: (agentId, text) =>
        set((s) => {
          const drafts = { ...s.drafts, [agentId]: text };
          if (!text) delete drafts[agentId];
          return { drafts };
        }),
      add: (outgoing) => set((s) => ({ outgoing: [...s.outgoing, outgoing] })),
      update: (id, changes) =>
        set((s) => ({
          outgoing: s.outgoing.map((o) =>
            o.id === id ? { ...o, ...changes } : o,
          ),
        })),
      remove: (id) =>
        set((s) => ({ outgoing: s.outgoing.filter((o) => o.id !== id) })),
    }),
    {
      name: "axp.chat.v1",
      storage,
      partialize: ({ drafts, outgoing }) => ({ drafts, outgoing }),
      // Loaded after hydration (see RootDocument), like the workspace store.
      skipHydration: true,
    },
  ),
);

/** Tries a request makes before the message shows as not delivered. */
const TRIES = 4;
const TRY_TIMEOUT = 20_000;
const NETWORK_FAILURE = "网络连接失败，消息未送达。";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One agent's messages go out one at a time, in the order they were sent.
const lines = new Map<string, Promise<void>>();
const delivering = new Set<string>();

function deliver(queryClient: QueryClient, outgoing: Outgoing) {
  if (delivering.has(outgoing.id)) return;
  delivering.add(outgoing.id);
  const line = (lines.get(outgoing.agentId) ?? Promise.resolve())
    .then(() => attempt(queryClient, outgoing))
    .finally(() => delivering.delete(outgoing.id));
  lines.set(outgoing.agentId, line);
}

async function attempt(queryClient: QueryClient, outgoing: Outgoing) {
  const { update, remove } = useOutbox.getState();
  for (let tries = 1; ; tries++) {
    // Discarded while it waited its turn.
    if (!useOutbox.getState().outgoing.some((o) => o.id === outgoing.id))
      return;
    try {
      const sent = await unwrap(
        controlPlane.POST("/api/v1/chat/messages", {
          body: {
            id: outgoing.id,
            agent_id: outgoing.agentId,
            text: outgoing.text,
            mode: outgoing.mode,
          },
          params: { header: { "Idempotency-Key": outgoing.id } },
          signal: AbortSignal.timeout(TRY_TIMEOUT),
        }),
      );
      addSent(queryClient, sent);
      remove(outgoing.id);
      if (outgoing.mode === "steer" && !sent.steered)
        toast("没有进行中的回复可以插入，这条消息已改为排队。");
      return;
    } catch (error) {
      // No answer, or the server's own trouble: it may have arrived, and the
      // same id makes another try safe.
      const unsure = !(error instanceof ApiError) || error.status >= 500;
      if (unsure && tries < TRIES) {
        await sleep(1000 * 2 ** (tries - 1));
        continue;
      }
      if (error instanceof ApiError && error.code.startsWith("MODEL_"))
        void refreshLlm(queryClient);
      update(outgoing.id, {
        failure: error instanceof ApiError ? error.message : NETWORK_FAILURE,
      });
      return;
    }
  }
}

/** Sending, retrying, editing and discarding the user's messages. */
export function useOutboxActions() {
  const queryClient = useQueryClient();
  const { add, update, remove, setDraft } = useOutbox.getState();
  return {
    send(agentId: string, text: string, mode: SendMode) {
      const outgoing = { id: crypto.randomUUID(), agentId, text, mode };
      add(outgoing);
      deliver(queryClient, outgoing);
    },
    retry(outgoing: Outgoing) {
      const again = { ...outgoing, failure: undefined };
      update(outgoing.id, { failure: undefined });
      deliver(queryClient, again);
    },
    /** Back into the draft, to be sent as a new message. */
    edit(outgoing: Outgoing) {
      remove(outgoing.id);
      const draft = useOutbox.getState().drafts[outgoing.agentId];
      setDraft(
        outgoing.agentId,
        draft ? `${outgoing.text}\n${draft}` : outgoing.text,
      );
    },
    discard: remove,
  };
}

/**
 * Picks up messages a reload interrupted, and drops those the transcript
 * already has (their response was lost, the stream brought them).
 */
export function useOutboxDelivery(arrived: ReadonlySet<string>) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const resume = () => {
      for (const outgoing of useOutbox.getState().outgoing)
        if (!outgoing.failure) deliver(queryClient, outgoing);
    };
    if (useOutbox.persist.hasHydrated()) resume();
    return useOutbox.persist.onFinishHydration(resume);
  }, [queryClient]);
  const outgoing = useOutbox((s) => s.outgoing);
  useEffect(() => {
    for (const o of outgoing)
      if (arrived.has(o.id)) useOutbox.getState().remove(o.id);
  }, [arrived, outgoing]);
}
