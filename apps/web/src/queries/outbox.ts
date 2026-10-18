import type { SendResult } from "@eta/client-contracts";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { Draft } from "@/lib/composer";
import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { draftOf } from "@/lib/composer";
import { translate } from "@/lib/i18n";
import { getWire, WireError } from "@/lib/wire";
import { rememberRows } from "@/queries/conversations";

// What the user has written and not yet seen arrive: a draft per conversation, and the messages on
// their way to the host. A message has its id from the moment it is sent; every try carries it as
// the `clientId` of `conversations.send`, which the host takes as the id of the row, so trying
// again (after a lost reply, a reload, a retry) is the same message, never a second one. Both
// survive a reload.

const draftSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("paste"), id: z.string(), text: z.string() }),
  ]),
);
const outgoingSchema = z.object({
  id: z.uuid(),
  conversationId: z.string().max(64),
  text: z.string(),
  mentions: z.array(z.string()),
  mode: z.enum(["queue", "steer"]),
  failure: z.string().max(500).optional(),
});
const savedSchema = z.object({
  drafts: z.record(z.string(), draftSchema),
  outgoing: z.array(outgoingSchema).max(100),
});

export type Outgoing = z.infer<typeof outgoingSchema>;
type Saved = z.infer<typeof savedSchema>;

/** "queue" waits for the agent's current reply; "steer" joins it. */
export type SendMode = Outgoing["mode"];

interface OutboxStore extends Saved {
  setDraft: (conversationId: string, draft: Draft) => void;
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
      setDraft: (conversationId, draft) =>
        set((s) => {
          const drafts = { ...s.drafts, [conversationId]: draft };
          if (!draft.length) delete drafts[conversationId];
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
      name: "eta.groups.v1",
      storage,
      partialize: ({ drafts, outgoing }) => ({ drafts, outgoing }),
      // Loaded in main.tsx before the first render, like the workspace store.
      skipHydration: true,
    },
  ),
);

/** Tries a request makes before the message shows as not delivered. */
const TRIES = 4;
const TRY_TIMEOUT = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One conversation's messages go out one at a time, in the order they were sent.
const lines = new Map<string, Promise<void>>();
const delivering = new Set<string>();

function deliver(outgoing: Outgoing) {
  if (delivering.has(outgoing.id)) return;
  delivering.add(outgoing.id);
  const line = (lines.get(outgoing.conversationId) ?? Promise.resolve())
    .then(() => attempt(outgoing))
    .finally(() => delivering.delete(outgoing.id));
  lines.set(outgoing.conversationId, line);
}

async function attempt(outgoing: Outgoing) {
  const { update, remove } = useOutbox.getState();
  for (let tries = 1; ; tries++) {
    // Discarded while it waited its turn.
    if (!useOutbox.getState().outgoing.some((o) => o.id === outgoing.id))
      return;
    try {
      const sent = await getWire().call<SendResult>(
        "conversations",
        "send",
        {
          conversationId: outgoing.conversationId,
          text: outgoing.text,
          mentions: outgoing.mentions,
          mode: outgoing.mode,
          clientId: outgoing.id,
        },
        { timeoutMs: TRY_TIMEOUT },
      );
      // The rows as the host wrote them, so the message does not wait for the next push.
      rememberRows(outgoing.conversationId, [sent.message, ...sent.replies]);
      remove(outgoing.id);
      return;
    } catch (error) {
      // No reply, or no connection: it may have arrived, and the same id makes another try safe.
      const unsure = !(error instanceof WireError) || error.code !== "server";
      if (unsure && tries < TRIES) {
        await sleep(1000 * 2 ** (tries - 1));
        continue;
      }
      update(outgoing.id, {
        failure:
          error instanceof WireError && error.code === "server"
            ? error.message
            : translate("chat:errors.messageNetworkFailure"),
      });
      return;
    }
  }
}

/** Sending, retrying, editing and discarding the user's messages. */
export function useOutboxActions() {
  const { add, update, remove, setDraft } = useOutbox.getState();
  return {
    send(
      conversationId: string,
      text: string,
      mode: SendMode,
      mentions: string[],
    ) {
      const outgoing = {
        id: crypto.randomUUID(),
        conversationId,
        text,
        mode,
        mentions,
      };
      add(outgoing);
      deliver(outgoing);
    },
    retry(outgoing: Outgoing) {
      update(outgoing.id, { failure: undefined });
      deliver({ ...outgoing, failure: undefined });
    },
    /** Back into the draft, to be sent as a new message. */
    edit(outgoing: Outgoing) {
      remove(outgoing.id);
      const draft = draftOf(outgoing.text);
      const current =
        useOutbox.getState().drafts[outgoing.conversationId] ?? [];
      setDraft(
        outgoing.conversationId,
        current.length
          ? [...draft, { type: "text", text: "\n" }, ...current]
          : draft,
      );
    },
    discard: remove,
  };
}

/**
 * Picks up messages a reload interrupted, and drops those the timeline already has (their reply
 * was lost, the push brought them).
 */
export function useOutboxDelivery(arrived: ReadonlySet<string>) {
  useEffect(() => {
    const resume = () => {
      for (const outgoing of useOutbox.getState().outgoing)
        if (!outgoing.failure) deliver(outgoing);
    };
    if (useOutbox.persist.hasHydrated()) resume();
    return useOutbox.persist.onFinishHydration(resume);
  }, []);
  const outgoing = useOutbox((s) => s.outgoing);
  useEffect(() => {
    for (const o of outgoing)
      if (arrived.has(o.id)) useOutbox.getState().remove(o.id);
  }, [arrived, outgoing]);
}
