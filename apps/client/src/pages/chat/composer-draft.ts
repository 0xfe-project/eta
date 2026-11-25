import type {
  AttachmentView,
  ConversationResults,
} from "@eta/client-contracts";
import type { DocNode, UploadState } from "@eta/client-contracts/composer-doc";
import type { PasteRange } from "@eta/client-contracts/composer-draft";
import type { StickyTarget } from "@eta/client-contracts/composer-target";
import type { Uploads } from "../../components/eta-editor";
import type { useHost } from "../../services/host";
import { legacyDraftToDoc } from "@eta/client-contracts/composer-doc";
import { WireError } from "@eta/client-contracts/wire";
import { cleanup, computed, effect, signal, Storage } from "nsh";
import { problemText } from "../../services/problem-text";
import {
  conversationUploads,
  createUploadQueue,
} from "../../services/upload-queue";

export interface Outgoing {
  /** The `clientId` it is sent with, which the host makes the row's id. */
  id: string;
  text: string;
  mentions?: string[];
  attachments: AttachmentView[];
  blocks?: PasteRange[];
  failure?: string;
  /** When it was sent, for its row in the transcript. */
  at?: number;
  /**
   * Where it shows until the host answers: the agents it will wait for (every agent it goes to was
   * answering as it was sent: the queue above the composer), or none (the end of the transcript).
   * Told once, as it is sent, so it does not move while it goes; a message saved from an earlier
   * run of the app has none yet and is told again when its chat opens (`outboxPlaces`).
   */
  waitsFor?: string[];
}

/** A sent message the host took, until its row reaches this window. */
export interface Landed {
  message: Outgoing;
  /** The agents the host held it for (it waits in the queue), or none (it is in the transcript). */
  held: string[];
}
/** What a chat keeps between visits: the editor's document, its finished uploads, the outbox. */
interface Draft {
  doc: DocNode | null;
  /** Uploaded attachments by block id (the document's attachment blocks name them). */
  uploads: Record<string, AttachmentView>;
  sticky?: StickyTarget;
  outgoing: Outgoing[];
}
const empty = (): Draft => ({ doc: null, uploads: {}, outgoing: [] });

type Host = ReturnType<typeof useHost>;

const opened = new Map<string, ReturnType<typeof createDraft>>();
function createDraft(key: string, legacyKey: string) {
  const value = signal<Draft>(empty());
  const ready = signal(false);
  /** Messages the host took whose row has not come yet: they stay where they were shown. */
  const landed = signal<Record<string, Landed>>({});
  /** A failed message the reader chose to edit: the composer takes it back into the box. */
  const editing = signal<Outgoing | undefined>(undefined);
  const busy = signal(false);
  /** Upload states of this session's blocks: uploading, failed, done (the done ones persist). */
  const queue = createUploadQueue({
    onDone: (id, attachment) =>
      void edit({ uploads: { ...value().uploads, [id]: attachment } }),
    onIdle: () => release(),
  });
  const { states, uploading } = queue;
  let users = 0;
  let writes = Promise.resolve();
  const unused = () =>
    !users &&
    !busy() &&
    !uploading() &&
    // A failed upload keeps its bytes here for a retry, in this chat, while the app runs.
    !queue.failed() &&
    ready() &&
    !value().outgoing.some((item) => !item.failure);
  function release() {
    if (!unused()) return;
    const pending = writes;
    void pending.then(() => {
      if (unused() && writes === pending && opened.get(key)?.value === value)
        opened.delete(key);
    });
  }
  function adopt(saved: Draft) {
    value.set(saved);
    states.set(
      Object.fromEntries(
        Object.entries(saved.uploads).map(([id, attachment]) => [
          id,
          { state: "done", attachment } satisfies UploadState,
        ]),
      ),
    );
  }
  const loaded = Storage.getItem(key)
    .then(async (raw) => {
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Draft>;
        adopt({
          doc: saved.doc ?? null,
          uploads: saved.uploads ?? {},
          sticky: saved.sticky,
          outgoing: Array.isArray(saved.outgoing)
            ? saved.outgoing.map(unplaced)
            : [],
        });
        return;
      }
      // The composer before the editor kept `{ text, prefix, attachments }`: read it once.
      const old = await Storage.getItem(legacyKey);
      if (!old) return;
      const saved = JSON.parse(old) as Record<string, unknown>;
      const { doc, uploads } = legacyDraftToDoc(saved);
      adopt({
        doc,
        uploads: Object.fromEntries(
          Object.entries(uploads).flatMap(([id, state]) =>
            state.state === "done" ? [[id, state.attachment]] : [],
          ),
        ),
        sticky: saved.sticky as StickyTarget | undefined,
        outgoing: Array.isArray(saved.outgoing)
          ? (saved.outgoing as Outgoing[]).map(unplaced)
          : [],
      });
      await edit({});
      await Storage.removeItem(legacyKey);
    })
    .catch(() => {})
    .finally(() => {
      ready.set(true);
      release();
    });
  function edit(patch: Partial<Draft>) {
    const next = { ...value(), ...patch };
    value.set(next);
    // Coalesce queued keystrokes while preserving the order of writes on native storage.
    writes = writes
      .then(async () => {
        if (value() !== next) return;
        const blank =
          !next.doc ||
          !JSON.stringify(next.doc).match(
            /"(text|attachment|pasteBlock|mention)"/,
          );
        if (
          !blank ||
          Object.keys(next.uploads).length ||
          next.sticky ||
          next.outgoing.length
        )
          await Storage.setItem(key, JSON.stringify(next));
        else await Storage.removeItem(key);
      })
      .catch(() => {});
    return writes;
  }
  /** The attachment plugin's view of this draft's uploads, for one host and chat. */
  function uploads(host: Host, conversationId: string): Uploads {
    return queue.uploads(host, conversationUploads(host, conversationId));
  }
  const entry = {
    value,
    landed,
    editing,
    loaded,
    ready,
    busy,
    uploading,
    states,
    uploads,
    release,
    flushed: () => writes,
    retain() {
      users++;
      cleanup(() => {
        users--;
        release();
      });
    },
    edit,
    /** The rows of these landed messages have come: they show as the host's from now on. */
    settle(ids: readonly string[]) {
      const all = landed();
      if (!ids.some((id) => id in all)) return;
      const next = { ...all };
      for (const id of ids) delete next[id];
      landed.set(next);
    },
    /** Attachments of a message brought back to edit: uploaded already. */
    remember: queue.remember,
    /** Takes back uploads the sent message did not carry (blocks taken out before sending). */
    forget(host: Host, conversationId: string, kept: readonly string[]) {
      const left = Object.keys(value().uploads).filter(
        (id) => !kept.includes(id),
      );
      queue.clear(host, conversationUploads(host, conversationId), left);
      edit({ uploads: {} });
    },
  };
  return entry;
}

/** How long a sent message waits for its row before it stops being shown. */
const LANDED_FOR_MS = 15_000;

/** Messages sent in this run of the app: they keep the place they were given as they went. */
const sentThisRun = new Set<string>();
/** Remembers a message as sent in this run, so a chat opened again shows it where it was. */
export function placedNow(message: Outgoing): Outgoing {
  sentThisRun.add(message.id);
  return message;
}
/**
 * A message read back from storage. One from an earlier run of the app is placed again (`waitsFor`)
 * by who is busy now; one from this run, read again because its chat was opened again, stays put.
 */
function unplaced(message: Outgoing): Outgoing {
  if (sentThisRun.has(message.id)) return message;
  const { waitsFor: _waitsFor, ...rest } = message;
  return rest;
}

const storagePrefix = "eta.composer.v2.";
const legacyPrefix = "eta.composer.v1.";
function getDraft(name: string) {
  const key = storagePrefix + name;
  let draft = opened.get(key);
  if (!draft) {
    draft = createDraft(key, legacyPrefix + name);
    opened.set(key, draft);
  }
  return draft;
}

export function openComposerDraft(origin: string, conversationId: string) {
  const draft = getDraft(JSON.stringify([origin, conversationId]));
  draft.retain();
  return draft;
}

export async function drainOutbox(
  store: ReturnType<typeof openComposerDraft>,
  host: Host,
  origin: string,
  conversationId: string,
) {
  const { busy, edit, ready } = store;
  const outgoing = () => store.value().outgoing;
  if (
    !ready() ||
    busy() ||
    host.address()?.origin !== origin ||
    host.state().status !== "open" ||
    !outgoing().some((item) => !item.failure)
  )
    return;
  async function deliver(message: Outgoing) {
    for (let attempt = 1; ; attempt++) {
      if (host.address()?.origin !== origin) return;
      try {
        const sent = await host.call<ConversationResults["send"]>(
          "conversations",
          "send",
          {
            conversationId,
            clientId: message.id,
            text: message.text,
            mode: "queue",
            mentions: message.mentions,
            blocks: message.blocks,
            attachments: message.attachments.map((file) => file.id),
          },
        );
        // Shown where the host put it until its row comes (it may have come already).
        store.landed.update((all) => ({
          ...all,
          [message.id]: {
            message,
            held:
              sent.message.data.held === true &&
              Array.isArray(sent.message.data.woke)
                ? (sent.message.data.woke as string[])
                : [],
          },
        }));
        edit({ outgoing: outgoing().filter((item) => item.id !== message.id) });
        // A row that never comes to this window (taken back from another one) goes all the same.
        setTimeout(() => store.settle([message.id]), LANDED_FOR_MS);
        return;
      } catch (cause) {
        if (
          cause instanceof WireError &&
          cause.code !== "server" &&
          attempt < 3
        ) {
          await new Promise((resolve) =>
            setTimeout(resolve, 1000 * 2 ** (attempt - 1)),
          );
          continue;
        }
        const failure = problemText(cause);
        edit({
          outgoing: outgoing().map((item) =>
            item.id === message.id ? { ...item, failure } : item,
          ),
        });
        return;
      }
    }
  }
  busy.set(true);
  try {
    while (
      host.address()?.origin === origin &&
      host.state().status === "open"
    ) {
      const next = outgoing().find((item) => !item.failure);
      if (!next) break;
      await store.flushed();
      await deliver(next);
    }
  } finally {
    busy.set(false);
    store.release();
  }
}

/** Sends a failed message again, with the same id: the host keeps one copy whatever happened. */
export function retryOutgoing(
  store: ReturnType<typeof openComposerDraft>,
  host: Host,
  origin: string,
  conversationId: string,
  id: string,
) {
  store.edit({
    outgoing: store
      .value()
      .outgoing.map((item) =>
        item.id === id ? { ...item, failure: undefined } : item,
      ),
  });
  void drainOutbox(store, host, origin, conversationId);
}

// A queued send belongs to its conversation even when another chat is on screen.
export function resumeComposerOutbox(host: Host) {
  const connected = computed(() =>
    host.state().status === "open" ? host.address()?.origin : undefined,
  );
  effect(() => {
    const origin = connected();
    if (!origin) return;
    const scope = `${JSON.stringify([origin]).slice(0, -1)},`;
    void Storage.keys()
      .then(async (keys) => {
        const names = new Set<string>();
        for (const key of [...keys, ...opened.keys()])
          for (const prefix of [storagePrefix, legacyPrefix])
            if (key.startsWith(prefix + scope))
              names.add(key.slice(prefix.length));
        for (const name of names) {
          if (host.address()?.origin !== origin) continue;
          let id: unknown;
          try {
            [, id] = JSON.parse(name);
          } catch {
            continue;
          }
          if (typeof id !== "string") continue;
          const store = getDraft(name);
          await store.loaded;
          await drainOutbox(store, host, origin, id);
        }
      })
      .catch(() => {});
  });
}
