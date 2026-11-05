// What the user has written and not yet seen arrive: a draft per conversation, the group's chosen
// target, files on their way and the messages on theirs. As apps/web/src/queries/outbox.ts: a
// message has its id from the moment it is sent, every try carries it as `clientId`, so trying
// again is the same message and never a second one.

import type { AttachmentView, SendResult } from "@eta/client-contracts";
import type { StickyTarget } from "./mentions";
import {
  ATTACH_CHUNK_BYTES,
  MAX_ATTACHMENT_BYTES,
} from "@eta/client-contracts";
import { signal, Storage, untracked } from "nsh";
import { wire } from "../../app/session";
import { t } from "../../i18n";
import { WireError } from "../../wire/wire";
import { rememberRows } from "./rows";

export type SendMode = "queue" | "steer";

export interface Outgoing {
  id: string;
  conversationId: string;
  text: string;
  mentions: string[];
  mode: SendMode;
  attachments: AttachmentView[];
  failure?: string | undefined;
}

export interface Upload {
  id: string;
  conversationId: string;
  name: string;
  size: number;
  attachment?: AttachmentView | undefined;
  error?: string | undefined;
}

const STORAGE_KEY = "eta.outbox.v1";
/** Tries a request makes before the message shows as not delivered. */
const TRIES = 4;
const TRY_TIMEOUT = 20_000;

export const drafts = signal<Record<string, string>>({});
export const stickies = signal<Record<string, StickyTarget>>({});
export const outgoing = signal<Outgoing[]>([]);
export const uploads = signal<Upload[]>([]);

let loading: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void Storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        drafts: untracked(() => drafts()),
        stickies: untracked(() => stickies()),
        outgoing: untracked(() => outgoing()),
      }),
    );
  }, 300);
}

/** Bring back what was left when the app last closed, and pick up messages it cut off. */
export function loadOutbox(): Promise<void> {
  loading ??= (async () => {
    const saved = await Storage.getItem(STORAGE_KEY);
    if (saved === null || saved === undefined) return;
    try {
      const state = JSON.parse(saved) as {
        drafts?: Record<string, string>;
        stickies?: Record<string, StickyTarget>;
        outgoing?: Outgoing[];
      };
      drafts.update((now) => ({ ...state.drafts, ...now }));
      stickies.update((now) => ({ ...state.stickies, ...now }));
      outgoing.update((now) => [...(state.outgoing ?? []), ...now]);
      for (const item of state.outgoing ?? [])
        if (item.failure === undefined) deliver(item);
    } catch {
      // A value this version did not write: start from nothing.
    }
  })();
  return loading;
}

export function setDraft(conversationId: string, text: string): void {
  drafts.update((all) => {
    const { [conversationId]: _gone, ...rest } = all;
    return text === "" ? rest : { ...all, [conversationId]: text };
  });
  save();
}

export function setSticky(
  conversationId: string,
  sticky: StickyTarget | undefined,
): void {
  stickies.update((all) => {
    const { [conversationId]: _gone, ...rest } = all;
    return sticky === undefined ? rest : { ...all, [conversationId]: sticky };
  });
  save();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One conversation's messages go out one at a time, in the order they were sent.
const lines = new Map<string, Promise<void>>();
const delivering = new Set<string>();

const isOut = (id: string) =>
  untracked(() => outgoing()).some((item) => item.id === id);
const update = (id: string, changes: Partial<Outgoing>) => {
  outgoing.update((all) =>
    all.map((item) => (item.id === id ? { ...item, ...changes } : item)),
  );
  save();
};
export const discard = (id: string) => {
  outgoing.update((all) => all.filter((item) => item.id !== id));
  save();
};

async function attempt(item: Outgoing): Promise<void> {
  for (let tries = 1; ; tries += 1) {
    // Discarded while it waited its turn.
    if (!isOut(item.id)) return;
    try {
      const sent = await wire().call<SendResult>(
        "conversations",
        "send",
        {
          conversationId: item.conversationId,
          text: item.text,
          mentions: item.mentions,
          mode: item.mode,
          clientId: item.id,
          ...(item.attachments.length === 0
            ? {}
            : { attachments: item.attachments.map((file) => file.id) }),
        },
        { timeoutMs: TRY_TIMEOUT },
      );
      // A held message is the band over the composer's, not the transcript's: the next window will
      // carry neither it nor the reply queued under it.
      rememberRows(
        item.conversationId,
        sent.message.data.held === true ? [] : [sent.message, ...sent.replies],
      );
      discard(item.id);
      return;
    } catch (error) {
      // No reply, or no connection: it may have arrived, and the same id makes another try safe.
      const unsure = !(error instanceof WireError) || error.code !== "server";
      if (unsure && tries < TRIES) {
        await sleep(1000 * 2 ** (tries - 1));
        continue;
      }
      update(item.id, {
        failure:
          error instanceof WireError && error.code === "server"
            ? error.message
            : t("chat.errors.networkFailure"),
      });
      return;
    }
  }
}

function deliver(item: Outgoing): void {
  if (delivering.has(item.id)) return;
  delivering.add(item.id);
  const line = (lines.get(item.conversationId) ?? Promise.resolve())
    .then(() => attempt(item))
    .finally(() => delivering.delete(item.id));
  lines.set(item.conversationId, line);
}

export function send(
  conversationId: string,
  text: string,
  mode: SendMode,
  mentions: string[],
  attachments: AttachmentView[] = [],
): void {
  const item: Outgoing = {
    id: crypto.randomUUID(),
    conversationId,
    text,
    mode,
    mentions,
    attachments,
  };
  outgoing.update((all) => [...all, item]);
  save();
  deliver(item);
}

export function retry(item: Outgoing): void {
  update(item.id, { failure: undefined });
  deliver({ ...item, failure: undefined });
}

/** Back into the draft, to be sent as a new message. */
export function edit(item: Outgoing): void {
  discard(item.id);
  const current = untracked(() => drafts())[item.conversationId] ?? "";
  setDraft(
    item.conversationId,
    current === "" ? item.text : `${item.text}\n${current}`,
  );
  uploads.update((all) => [
    ...all,
    ...item.attachments.map((attachment) => ({
      id: attachment.id,
      conversationId: item.conversationId,
      name: attachment.name,
      size: attachment.size,
      attachment,
    })),
  ]);
}

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

const setUpload = (id: string, changes: Partial<Upload>) =>
  uploads.update((all) =>
    all.map((file) => (file.id === id ? { ...file, ...changes } : file)),
  );

/** Upload a picked file, a chunk to a call, in order. The id is the upload's: resending is the same one. */
export async function attach(
  conversationId: string,
  file: File,
): Promise<void> {
  const id = crypto.randomUUID();
  uploads.update((all) => [
    ...all,
    { id, conversationId, name: file.name, size: file.size },
  ]);
  if (file.size > MAX_ATTACHMENT_BYTES) {
    setUpload(id, { error: t("chat.attachments.tooLarge") });
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const count = Math.max(1, Math.ceil(bytes.length / ATTACH_CHUNK_BYTES));
    for (let index = 0; index < count; index += 1) {
      const { attachment } = await wire().call<{
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
          data: base64Of(
            bytes.subarray(
              index * ATTACH_CHUNK_BYTES,
              (index + 1) * ATTACH_CHUNK_BYTES,
            ),
          ),
        },
        { timeoutMs: TRY_TIMEOUT },
      );
      if (attachment !== null) setUpload(id, { attachment });
    }
  } catch (error) {
    setUpload(id, {
      error:
        error instanceof WireError && error.code === "server"
          ? error.message
          : t("chat.attachments.networkFailure"),
    });
  }
}

/** The user took a file out: its unsent attachment goes too. */
export function dropUpload(upload: Upload): void {
  uploads.update((all) => all.filter((file) => file.id !== upload.id));
  if (upload.attachment !== undefined)
    void wire()
      .call("conversations", "unattach", {
        conversationId: upload.conversationId,
        attachmentId: upload.attachment.id,
      })
      .catch(() => undefined);
}

/** A sent message takes its files with it. */
export function clearUploads(conversationId: string): void {
  uploads.update((all) =>
    all.filter((file) => file.conversationId !== conversationId),
  );
}
