import type { AttachmentView } from "@eta/client-contracts";
import type { Signal } from "nsh";
import type { ViewedPicture } from "../components/picture-viewer";
import type { HostAddress } from "./host";
import { attachmentPicturePath, isPictureType } from "@eta/client-contracts";
import { platform, signal } from "nsh";
import { useHost } from "./host";

// The pictures among the attachments, as something `<Image>` shows, by host and attachment id (an
// upload's id is the id of the attachment it becomes): the bytes the composer uploaded while this
// app has them, else the host's copy (`GET /attachments/<id>`), fetched once and kept. A chip, its
// preview and the lightbox read the same entry, so a picture is fetched and decoded once.
//
// In a browser that is a `blob:` URL. The native apps' `<Image>` takes a URL and nothing else: no
// headers, so no bearer token, and `blob:` URLs there are for `fetch` only. There the picture is
// fetched with the token the socket uses and shown as a `data:` URL, as run images already are.
interface Entry {
  state: Signal<{ src?: string; failed?: boolean }>;
  request?: Promise<string>;
}

const entries = new Map<string, Entry>();

const keyOf = (origin: string, id: string) => `${origin} ${id}`;

function entryOf(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { state: signal<{ src?: string; failed?: boolean }>({}) };
    entries.set(key, entry);
  }
  return entry;
}

function pictureUrl(bytes: Uint8Array, type: string): string {
  if (platform.os === "web")
    return URL.createObjectURL(new Blob([bytes], { type }));
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** An attachment's size as its chip says it. */
export const fileSize = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

/** The composer uploaded `bytes` as attachment `id`: its picture is those bytes. */
export function rememberPicture(
  origin: string,
  id: string,
  bytes: Uint8Array,
  type: string | undefined,
) {
  if (!isPictureType(type)) return;
  forgetPicture(origin, id);
  const entry = entryOf(keyOf(origin, id));
  const src = pictureUrl(bytes, type!);
  entry.request = Promise.resolve(src);
  entry.state.set({ src });
}

/** The attachment was taken out of the draft: its picture goes with it. */
export function forgetPicture(origin: string, id: string) {
  const key = keyOf(origin, id);
  const entry = entries.get(key);
  entries.delete(key);
  const src = entry?.state().src;
  if (src?.startsWith("blob:")) URL.revokeObjectURL(src);
}

/**
 * The host's copy of a picture, kept by the app rather than by whoever asked: a row recycled
 * mid-fetch leaves it to the next one. A failed fetch is not kept, so the next asks again.
 */
function load(address: HostAddress, id: string) {
  const key = keyOf(address.origin, id);
  const entry = entryOf(key);
  if (entry.request) return;
  const path = attachmentPicturePath(id);
  const request = fetch(new URL(path, address.origin), {
    credentials: "same-origin",
    // The token must not follow a redirect away from the host.
    redirect: "error",
    headers: address.token
      ? { Authorization: `Bearer ${address.token}` }
      : undefined,
    signal: AbortSignal.timeout(60_000),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    const type = response.headers.get("content-type")?.split(";")[0];
    if (!isPictureType(type)) throw new Error(`${path}: not a picture`);
    return pictureUrl(new Uint8Array(await response.arrayBuffer()), type!);
  });
  entry.request = request;
  entry.state.set({});
  request.then(
    (src) => {
      if (entries.get(key) === entry) entry.state.set({ src });
      else if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    },
    () => {
      entry.request = undefined;
      entry.state.set({ failed: true });
    },
  );
}

/** Whether an attachment is one the host shows back as a picture. */
export const isPicture = (file: Pick<AttachmentView, "contentType">) =>
  isPictureType(file.contentType);

/**
 * The attachments' pictures of the connected host, as the preview and the lightbox show them.
 * `load` asks the host for one this app does not have; the transcript's rows exist only near the
 * viewport (`List`), so a chip that loads as it is made loads as it scrolls into view, not later,
 * on hover or on opening.
 */
export function useAttachmentPictures() {
  const host = useHost();
  return (
    file: Pick<AttachmentView, "id" | "name" | "size">,
  ): ViewedPicture & { load: () => void } => {
    const state = () => {
      const address = host.address();
      return address ? entryOf(keyOf(address.origin, file.id)).state() : {};
    };
    return {
      key: file.id,
      caption: `${file.name} · ${fileSize(file.size)}`,
      src: () => state().src,
      failed: () => state().failed === true,
      load: () => {
        const address = host.address();
        if (address) load(address, file.id);
      },
    };
  };
}
