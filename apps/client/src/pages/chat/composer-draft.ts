import type {
  AttachmentView,
  ConversationResults,
} from "@eta/client-contracts";
import type {
  Draft as DraftParts,
  PasteRange,
} from "@eta/client-contracts/composer-draft";
import type { StickyTarget } from "@eta/client-contracts/composer-target";
import type { useHost } from "../../services/host";
import { WireError } from "@eta/client-contracts/wire";
import { cleanup, computed, effect, signal, Storage } from "nsh";

export interface Outgoing {
  id: string;
  text: string;
  mentions?: string[];
  attachments: AttachmentView[];
  blocks?: PasteRange[];
  failure?: string;
}
interface Draft {
  text: string;
  attachments: AttachmentView[];
  prefix: DraftParts;
  sticky?: StickyTarget;
  outgoing: Outgoing[];
}
const empty = (): Draft => ({
  text: "",
  attachments: [],
  outgoing: [],
  prefix: [],
});

const opened = new Map<string, ReturnType<typeof createDraft>>();
function createDraft(key: string) {
  const value = signal<Draft>(empty());
  const ready = signal(false);
  const busy = signal(false);
  const uploading = signal(false);
  const failedUploads = signal<{ file: File; error: string }[]>([]);
  let users = 0;
  let fileJobs = Promise.resolve();
  let fileJobCount = 0;
  let writes = Promise.resolve();
  const unused = () =>
    !users &&
    !busy() &&
    !uploading() &&
    !failedUploads().length &&
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
  const loaded = Storage.getItem(key)
    .then((raw) => {
      if (!raw) return;
      const saved = JSON.parse(raw) as Draft;
      if (typeof saved.text === "string" && Array.isArray(saved.attachments))
        value.set({
          ...saved,
          prefix: Array.isArray(saved.prefix) ? saved.prefix : [],
          outgoing: Array.isArray(saved.outgoing) ? saved.outgoing : [],
        });
    })
    .catch(() => {})
    .finally(() => {
      ready.set(true);
      release();
    });
  const entry = {
    value,
    loaded,
    ready,
    busy,
    uploading,
    failedUploads,
    release,
    flushed: () => writes,
    async updateAttachments(job: () => Promise<unknown>) {
      fileJobCount++;
      uploading.set(true);
      const next = fileJobs.then(job);
      fileJobs = next.then(
        () => {},
        () => {},
      );
      try {
        await next;
      } finally {
        if (--fileJobCount === 0) {
          uploading.set(false);
          release();
        }
      }
    },
    retain() {
      users++;
      cleanup(() => {
        users--;
        release();
      });
    },
    edit(patch: Partial<Draft>) {
      const next = { ...value(), ...patch };
      value.set(next);
      // Coalesce queued keystrokes while preserving the order of writes on native storage.
      writes = writes
        .then(async () => {
          if (value() !== next) return;
          if (
            next.text ||
            next.prefix.length ||
            next.attachments.length ||
            next.sticky ||
            next.outgoing.length
          )
            await Storage.setItem(key, JSON.stringify(next));
          else await Storage.removeItem(key);
        })
        .catch(() => {});
      return writes;
    },
  };
  return entry;
}

const storagePrefix = "eta.composer.v1.";
function getDraft(key: string) {
  let draft = opened.get(key);
  if (!draft) {
    draft = createDraft(key);
    opened.set(key, draft);
  }
  return draft;
}

export function openComposerDraft(origin: string, conversationId: string) {
  const draft = getDraft(
    storagePrefix + JSON.stringify([origin, conversationId]),
  );
  draft.retain();
  return draft;
}

export async function drainOutbox(
  store: ReturnType<typeof openComposerDraft>,
  host: ReturnType<typeof useHost>,
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
        await host.call<ConversationResults["send"]>("conversations", "send", {
          conversationId,
          clientId: message.id,
          text: message.text,
          mode: "queue",
          mentions: message.mentions,
          blocks: message.blocks,
          attachments: message.attachments.map((file) => file.id),
        });
        edit({ outgoing: outgoing().filter((item) => item.id !== message.id) });
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
        const failure = cause instanceof Error ? cause.message : String(cause);
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

// A queued send belongs to its conversation even when another chat is on screen.
export function resumeComposerOutbox(host: ReturnType<typeof useHost>) {
  const connected = computed(() =>
    host.state().status === "open" ? host.address()?.origin : undefined,
  );
  effect(() => {
    const origin = connected();
    if (!origin) return;
    const prefix = `${storagePrefix + JSON.stringify([origin]).slice(0, -1)},`;
    void Storage.keys()
      .then(async (keys) => {
        for (const key of new Set([...keys, ...opened.keys()])) {
          if (!key.startsWith(prefix) || host.address()?.origin !== origin)
            continue;
          let id: unknown;
          try {
            [, id] = JSON.parse(key.slice(storagePrefix.length));
          } catch {
            continue;
          }
          if (typeof id !== "string") continue;
          const store = getDraft(key);
          await store.loaded;
          await drainOutbox(store, host, origin, id);
        }
      })
      .catch(() => {});
  });
}
