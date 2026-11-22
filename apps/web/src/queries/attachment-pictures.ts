import { useEffect, useState } from "react";

// The pictures among the attachments, as object URLs, by attachment id (an upload's id is the id
// of the attachment it becomes): the file the composer was given while this page has it, else the
// host's copy, fetched once (`GET /attachments/<id>`) and kept for the rest of the page's life.
// The chip's preview and the lightbox show the same URL, so a picture is fetched and decoded once.
const pictures = new Map<string, Promise<string>>();

/** Whether an attachment is a picture, by its type alone. */
export const isPicture = (contentType: string) =>
  contentType.startsWith("image/");

/** The composer was given `file` for upload `id`: its picture is the file itself. */
export function rememberPicture(id: string, file: File) {
  if (!isPicture(file.type)) return;
  pictures.set(id, Promise.resolve(URL.createObjectURL(file)));
}

/** The upload was taken out of the draft: its picture goes with it. */
export function forgetPicture(id: string) {
  const picture = pictures.get(id);
  pictures.delete(id);
  // A fetch that failed made no URL to let go of.
  void picture?.then(URL.revokeObjectURL, () => undefined);
}

/**
 * The host's copy of a picture, kept by the page rather than by whoever asked: a chip that goes off
 * screen mid-fetch leaves it to the next one. A failed fetch is not kept, so the next asks again.
 */
function fetchPicture(id: string): Promise<string> {
  const request = fetch(`/attachments/${encodeURIComponent(id)}`, {
    signal: AbortSignal.timeout(60_000),
  })
    .then((response) => {
      if (!response.ok)
        throw new Error(`/attachments/${id}: ${response.status}`);
      return response.blob();
    })
    .then((blob) => URL.createObjectURL(blob));
  request.catch(() => pictures.delete(id));
  pictures.set(id, request);
  return request;
}

/**
 * An attachment's picture as something an `<img>` can show. One this page does not have is asked
 * for when `wanted` says it is on screen, never later (on hover or on opening).
 */
export function useAttachmentPicture(
  id: string,
  wanted: boolean,
): { src: string | undefined; failed: boolean } {
  const [loaded, setLoaded] = useState<{
    id: string;
    src?: string;
    failed?: boolean;
  }>();
  useEffect(() => {
    let request = pictures.get(id);
    if (request === undefined) {
      if (!wanted) return undefined;
      request = fetchPicture(id);
    }
    let cancelled = false;
    request.then(
      (src) => {
        if (!cancelled) setLoaded({ id, src });
      },
      () => {
        if (!cancelled) setLoaded({ id, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, wanted]);
  const mine = loaded?.id === id ? loaded : undefined;
  return { src: mine?.src, failed: mine?.failed === true };
}
