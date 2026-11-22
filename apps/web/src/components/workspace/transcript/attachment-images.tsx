import type {
  AttachmentView,
  ConversationResults,
  RunImage,
} from "@eta/client-contracts";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getWire } from "@/lib/wire";
import { ImageStrip } from "./image-strip";

/** Pictures fetched from the host, by attachment: a sent file never changes. */
const pictures = new Map<string, Promise<RunImage>>();

function fetchPicture(conversationId: string, id: string): Promise<RunImage> {
  let request = pictures.get(id);
  if (request === undefined) {
    request = getWire()
      .call<ConversationResults["attachment"]>("conversations", "attachment", {
        conversationId,
        attachmentId: id,
      })
      .then((picture) => ({
        mimeType: picture.contentType,
        data: picture.data,
        entryId: id,
        index: 0,
      }));
    // A failed fetch is not kept: the next time the message is drawn it asks again.
    request.catch(() => pictures.delete(id));
    pictures.set(id, request);
  }
  return request;
}

/**
 * The images a sent message carried (`data.attachments`), as thumbnails that open over the window.
 * Each is read from the host once; while it loads, and if it cannot be read, its name stands in.
 */
export function AttachmentImages({
  conversationId,
  files,
}: {
  conversationId: string;
  files: readonly AttachmentView[];
}) {
  const { t: translateText } = useTranslation("chat");
  const [loaded, setLoaded] = useState<Record<string, RunImage | null>>({});
  const ids = files.map((file) => file.id).join(",");
  useEffect(() => {
    let cancelled = false;
    for (const id of ids.split(","))
      fetchPicture(conversationId, id).then(
        (image) => {
          if (!cancelled) setLoaded((was) => ({ ...was, [id]: image }));
        },
        () => {
          if (!cancelled) setLoaded((was) => ({ ...was, [id]: null }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [conversationId, ids]);
  const images = files.flatMap((file) => loaded[file.id] ?? []);
  const failed = files.filter((file) => loaded[file.id] === null);
  return (
    <>
      {images.length > 0 ? (
        <ImageStrip sessionId={undefined} images={images} />
      ) : null}
      {failed.map((file) => (
        <span key={file.id} role="status" className="image-pending">
          {`${file.name} · ${translateText("images.failed")}`}
        </span>
      ))}
    </>
  );
}
