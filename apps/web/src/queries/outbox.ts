import type { QueryClient } from "@tanstack/react-query";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { Attachment, Draft, OutgoingPart } from "@/lib/composer";
import type { SendMode } from "@/queries/chat";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ApiError, controlPlane, unwrap } from "@/lib/api";
import { draftOf, MAX_ATTACHMENT_BYTES } from "@/lib/composer";
import { translate } from "@/lib/i18n";
import { addSent } from "@/queries/chat";
import { refreshLlm } from "@/queries/llm";

// What the user has written and not yet seen arrive: a draft per group, the
// files pasted into drafts (uploaded to that group at once), and the
// messages on their way to the control plane. A message has its id from the
// moment it is sent; every try carries it, as the message's id and as the
// Idempotency-Key, so trying again (after a lost response, a reload, a
// retry) is the same message, never a second one. All survive a reload.

const attachmentSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(400),
  content_type: z.string().max(200),
  size: z.number(),
});
const draftSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("paste"), id: z.string(), text: z.string() }),
    z.object({
      type: z.literal("file"),
      id: z.string(),
      name: z.string().max(400),
      contentType: z.string().max(200),
      size: z.number(),
    }),
  ]),
);
const partsSchema = z.array(
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("attachment"), attachment: attachmentSchema }),
  ]),
);
const outgoingSchema = z.object({
  id: z.string().uuid(),
  groupId: z.string().max(64),
  parts: partsSchema,
  mentions: z.array(z.string()),
  mode: z.enum(["queue", "steer"]),
  failure: z.string().max(500).optional(),
});
/** A pasted file's upload: uploading until it has its attachment or an error. */
const uploadSchema = z.object({
  groupId: z.string().max(64),
  attachment: attachmentSchema.optional(),
  error: z.string().max(500).optional(),
});
const savedSchema = z.object({
  drafts: z.record(z.string(), draftSchema),
  uploads: z.record(z.string(), uploadSchema).default({}),
  outgoing: z.array(outgoingSchema).max(100),
});

export type Outgoing = z.infer<typeof outgoingSchema>;
type Upload = z.infer<typeof uploadSchema>;
type Saved = z.infer<typeof savedSchema>;

interface OutboxStore extends Saved {
  setDraft: (groupId: string, draft: Draft) => void;
  setUpload: (id: string, upload: Upload) => void;
  add: (outgoing: Outgoing) => void;
  update: (id: string, changes: Partial<Outgoing>) => void;
  remove: (id: string) => void;
}

const interrupted = () => translate("chat:attachments.errors.interrupted");

const storage: PersistStorage<Saved> = {
  getItem: (name) => {
    try {
      const saved = localStorage.getItem(name);
      if (!saved) return null;
      const result = savedSchema.safeParse(JSON.parse(saved));
      if (!result.success) return null;
      // Only drafts' blocks keep their uploads; those a reload cut off are
      // failed, their files gone with the page.
      const blocks = new Set(
        Object.values(result.data.drafts).flatMap((d) =>
          d.map((p) => ("id" in p ? p.id : "")),
        ),
      );
      const uploads = Object.fromEntries(
        Object.entries(result.data.uploads)
          .filter(([id]) => blocks.has(id))
          .map(([id, upload]) => [
            id,
            upload.attachment || upload.error
              ? upload
              : { ...upload, error: interrupted() },
          ]),
      );
      return { state: { ...result.data, uploads } };
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
      uploads: {},
      outgoing: [],
      setDraft: (groupId, draft) =>
        set((s) => {
          const drafts = { ...s.drafts, [groupId]: draft };
          if (!draft.length) delete drafts[groupId];
          return { drafts };
        }),
      setUpload: (id, upload) =>
        set((s) => ({ uploads: { ...s.uploads, [id]: upload } })),
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
      name: "axp.groups.v1",
      storage,
      partialize: ({ drafts, uploads, outgoing }) => ({
        drafts,
        uploads,
        outgoing,
      }),
      // Loaded after hydration (see RootDocument), like the workspace store.
      skipHydration: true,
    },
  ),
);

/** Tries a request makes before the message shows as not delivered. */
const TRIES = 4;
const TRY_TIMEOUT = 20_000;
const networkFailure = () => translate("chat:errors.messageNetworkFailure");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One group's messages go out one at a time, in the order they were sent.
const lines = new Map<string, Promise<void>>();
const delivering = new Set<string>();

function deliver(queryClient: QueryClient, outgoing: Outgoing) {
  if (delivering.has(outgoing.id)) return;
  delivering.add(outgoing.id);
  const line = (lines.get(outgoing.groupId) ?? Promise.resolve())
    .then(() => attempt(queryClient, outgoing))
    .finally(() => delivering.delete(outgoing.id));
  lines.set(outgoing.groupId, line);
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
            group_id: outgoing.groupId,
            mentions: outgoing.mentions,
            parts: outgoing.parts.map((part) =>
              part.type === "text"
                ? part
                : {
                    type: "attachment" as const,
                    attachment_id: part.attachment.id,
                  },
            ),
            mode: outgoing.mode,
          },
          params: { header: { "Idempotency-Key": outgoing.id } },
          signal: AbortSignal.timeout(TRY_TIMEOUT),
        }),
      );
      addSent(queryClient, sent);
      remove(outgoing.id);
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
        failure: error instanceof ApiError ? error.message : networkFailure(),
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
    send(
      groupId: string,
      parts: OutgoingPart[],
      mode: SendMode,
      mentions: string[],
    ) {
      const outgoing = {
        id: crypto.randomUUID(),
        groupId,
        parts,
        mode,
        mentions,
      };
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
      const { draft, attachments } = draftOf(outgoing.parts);
      for (const [id, attachment] of Object.entries(attachments))
        useOutbox
          .getState()
          .setUpload(id, { groupId: outgoing.groupId, attachment });
      const current = useOutbox.getState().drafts[outgoing.groupId] ?? [];
      setDraft(
        outgoing.groupId,
        current.length
          ? [...draft, { type: "text", text: "\n" }, ...current]
          : draft,
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

// The files of this page's uploads, to retry them and to show them before
// they are uploaded.
const files = new Map<string, File>();

const previews = new Map<string, string>();

/** The pasted file behind a block, while this page has it. */
export function pastedFile(id: string) {
  return files.get(id);
}

/** An address for the pasted file, to show it before it is uploaded. */
export function pastedPreview(id: string) {
  const file = files.get(id);
  if (!file) return undefined;
  let url = previews.get(id);
  if (!url) {
    url = URL.createObjectURL(file);
    previews.set(id, url);
  }
  return url;
}

/** Upload a file pasted into the group's draft, as the block id. */
export async function upload(groupId: string, id: string, file: File) {
  const { setUpload } = useOutbox.getState();
  files.set(id, file);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    setUpload(id, {
      groupId,
      error: translate("chat:attachments.errors.fileTooLarge"),
    });
    return;
  }
  setUpload(id, { groupId });
  try {
    const response = await fetch(
      `/api/v1/groups/${groupId}/attachments?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        body?.error?.message ??
          translate("chat:attachments.errors.uploadFailed"),
      );
    setUpload(id, { groupId, attachment: body as Attachment });
  } catch (error) {
    setUpload(id, {
      groupId,
      error:
        error instanceof TypeError
          ? translate("chat:attachments.errors.uploadNetworkFailure")
          : (error as Error).message,
    });
  }
}

/** Upload the block's file again; false when this page no longer has it. */
export function retryUpload(id: string) {
  const file = files.get(id);
  const saved = useOutbox.getState().uploads[id];
  if (!file || !saved) return false;
  void upload(saved.groupId, id, file);
  return true;
}

/** The user took the block out: its unsent attachment goes too. */
export function dropUpload(id: string) {
  const { uploads, setUpload } = useOutbox.getState();
  const attachment = uploads[id]?.attachment;
  files.delete(id);
  const preview = previews.get(id);
  if (preview) URL.revokeObjectURL(preview);
  previews.delete(id);
  // Should an undo bring the block back, it says so.
  if (uploads[id])
    setUpload(id, {
      groupId: uploads[id].groupId,
      error: translate("chat:attachments.errors.removed"),
    });
  if (attachment)
    void controlPlane
      .DELETE("/api/v1/chat/attachments/{attachment_id}", {
        params: { path: { attachment_id: attachment.id } },
      })
      .catch(() => {});
}
