import type { AttachmentView, SendResult } from "@eta/client-contracts";
import type { PersistStorage, StorageValue } from "zustand/middleware";
import type { Draft, FilePart } from "@/lib/composer";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
} from "@eta/client-contracts";
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
// again (after a lost reply, a reload, a retry) is the same message, never a second one. Files
// pasted or picked into a draft are uploaded at once, chunk by chunk over the same wire; the draft
// holds a block for each and `uploads` what became of it. All of it survives a reload.

const attachmentSchema = z.object({
  id: z.string().max(64),
  name: z.string().max(400),
  contentType: z.string().max(200),
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
const outgoingSchema = z.object({
  id: z.uuid(),
  conversationId: z.string().max(64),
  text: z.string(),
  mentions: z.array(z.string()),
  mode: z.enum(["queue", "steer"]),
  attachments: z.array(attachmentSchema).max(10).default([]),
  failure: z.string().max(500).optional(),
});
/** A pasted file's upload: uploading until it has its attachment or an error. */
const uploadSchema = z.object({
  conversationId: z.string().max(64),
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

/** "queue" waits for the agent's current reply; "steer" joins it. */
export type SendMode = Outgoing["mode"];

interface OutboxStore extends Saved {
  setDraft: (conversationId: string, draft: Draft) => void;
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
      // Only drafts' blocks keep their uploads; those a reload cut off are failed, their files
      // gone with the page.
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
      setDraft: (conversationId, draft) =>
        set((s) => {
          const drafts = { ...s.drafts, [conversationId]: draft };
          if (!draft.length) delete drafts[conversationId];
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
      name: "eta.groups.v1",
      storage,
      partialize: ({ drafts, uploads, outgoing }) => ({
        drafts,
        uploads,
        outgoing,
      }),
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
          ...(outgoing.attachments.length === 0
            ? {}
            : { attachments: outgoing.attachments.map((a) => a.id) }),
        },
        { timeoutMs: TRY_TIMEOUT },
      );
      // The rows as the host wrote them, so the message does not wait for the next push. A held
      // message is not one the transcript should show, nor is the reply queued under it: the next
      // window will carry neither, and the chip above the composer is where both belong until a
      // lane takes the message (`useConversation` filters them out of what it hands the page, so
      // the rows the window does bring are held back too).
      rememberRows(
        outgoing.conversationId,
        sent.message.data?.held === true ? [] : [sent.message, ...sent.replies],
      );
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
      attachments: AttachmentView[] = [],
    ) {
      const outgoing = {
        id: crypto.randomUUID(),
        conversationId,
        text,
        mode,
        mentions,
        attachments,
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
      const draft: Draft = [
        ...draftOf(outgoing.text),
        ...outgoing.attachments.map((attachment): FilePart => {
          const id = crypto.randomUUID();
          useOutbox.getState().setUpload(id, {
            conversationId: outgoing.conversationId,
            attachment,
          });
          return { type: "file", id, ...fileOf(attachment) };
        }),
      ];
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

function fileOf(attachment: AttachmentView) {
  return {
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
  };
}

// The files of this page's uploads, to upload them again after a failure.
const files = new Map<string, File>();

/** A file's bytes as base64, for the wire. */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Upload a file to the conversation, a chunk to a call, in order. The block's id is the upload's
 * id, so sending it all again after a failure is the same upload starting over.
 */
async function upload(conversationId: string, id: string, file: File) {
  const { setUpload } = useOutbox.getState();
  files.set(id, file);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    setUpload(id, {
      conversationId,
      error: translate("chat:attachments.errors.fileTooLarge"),
    });
    return;
  }
  setUpload(id, { conversationId });
  const count = Math.max(1, Math.ceil(file.size / ATTACH_CHUNK_BYTES));
  try {
    for (let index = 0; index < count; index++) {
      const { attachment } = await getWire().call<{
        attachment: AttachmentView | null;
      }>(
        "conversations",
        "attach",
        {
          conversationId,
          uploadId: id,
          name: file.name,
          contentType: file.type || "application/octet-stream",
          index,
          last: index === count - 1,
          data: await base64Of(
            file.slice(
              index * ATTACH_CHUNK_BYTES,
              (index + 1) * ATTACH_CHUNK_BYTES,
            ),
          ),
        },
        { timeoutMs: TRY_TIMEOUT },
      );
      if (attachment !== null) setUpload(id, { conversationId, attachment });
    }
  } catch (error) {
    setUpload(id, {
      conversationId,
      error:
        error instanceof WireError && error.code === "server"
          ? error.message
          : translate("chat:attachments.errors.uploadNetworkFailure"),
    });
  }
}

/** A file pasted or picked into the conversation's draft: the block for it, already uploading. */
export function beginUpload(conversationId: string, file: File): FilePart {
  const id = crypto.randomUUID();
  void upload(conversationId, id, file);
  return {
    type: "file",
    id,
    name: file.name,
    contentType: file.type || "application/octet-stream",
    size: file.size,
  };
}

/** Upload the block's file again; false when this page no longer has it. */
export function retryUpload(id: string) {
  const file = files.get(id);
  const saved = useOutbox.getState().uploads[id];
  if (!file || !saved) return false;
  void upload(saved.conversationId, id, file);
  return true;
}

/** The user took the block out: its unsent attachment goes too. */
export function dropUpload(id: string) {
  const { uploads, setUpload } = useOutbox.getState();
  const saved = uploads[id];
  files.delete(id);
  // Should an undo bring the block back, it says so.
  if (saved)
    setUpload(id, {
      conversationId: saved.conversationId,
      error: translate("chat:attachments.errors.removed"),
    });
  if (saved?.attachment)
    void getWire()
      .call("conversations", "unattach", {
        conversationId: saved.conversationId,
        attachmentId: saved.attachment.id,
      })
      .catch(() => {});
}
