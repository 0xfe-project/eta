import type { RunImage } from "@/lib/run";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionImage } from "@/queries/sessions";

/**
 * The pictures a message carried (a screenshot a tool read back, an image the user attached), as
 * thumbnails. A thumbnail opens the picture over the whole window, where it is fitted to the
 * screen; clicking it there shows it at its own size, and the arrow keys walk through the rest.
 */
export function ImageStrip({
  sessionId,
  images,
}: {
  sessionId: string | null | undefined;
  images: readonly RunImage[];
}) {
  const { t: translateText } = useTranslation("chat");
  const [open, setOpen] = useState<number>();
  return (
    <>
      <div className="image-strip">
        {images.map((image, index) => (
          <button
            key={`${image.entryId}:${image.index}`}
            type="button"
            className="image-thumb"
            aria-label={translateText("images.open", {
              index: index + 1,
              count: images.length,
            })}
            onClick={() => setOpen(index)}
          >
            <Picture sessionId={sessionId} image={image} />
          </button>
        ))}
      </div>
      <Dialog
        open={open !== undefined}
        onOpenChange={(next) => {
          if (!next) setOpen(undefined);
        }}
      >
        {open === undefined ? null : (
          <Lightbox
            sessionId={sessionId}
            images={images}
            index={open}
            onIndex={setOpen}
          />
        )}
      </Dialog>
    </>
  );
}

function Lightbox({
  sessionId,
  images,
  index,
  onIndex,
}: {
  sessionId: string | null | undefined;
  images: readonly RunImage[];
  index: number;
  onIndex: (index: number) => void;
}) {
  const { t: translateText } = useTranslation("chat");
  const [actual, setActual] = useState(false);
  const image = images[index]!;
  const step = (by: number) => {
    const next = index + by;
    if (next < 0 || next >= images.length) return;
    setActual(false);
    onIndex(next);
  };
  return (
    <DialogContent
      className="lightbox inset-0 h-dvh w-screen max-h-none max-w-none translate-x-0 translate-y-0 gap-0 p-0 sm:max-w-none"
      onKeyDown={(event) => {
        if (event.key === "ArrowRight") step(1);
        else if (event.key === "ArrowLeft") step(-1);
      }}
    >
      <DialogTitle className="sr-only">
        {translateText("images.title", {
          index: index + 1,
          count: images.length,
        })}
      </DialogTitle>
      <DialogDescription className="sr-only">
        {translateText("images.hint")}
      </DialogDescription>
      <div
        className="lightbox-stage"
        data-actual={actual ? "true" : undefined}
        onClick={() => setActual((was) => !was)}
      >
        <Picture sessionId={sessionId} image={image} />
      </div>
      <div className="lightbox-bar">
        <span>
          {images.length > 1 ? `${index + 1} / ${images.length} · ` : ""}
          {sizeLabel(image)}
        </span>
        {images.length > 1 ? (
          <span className="flex gap-3">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              {translateText("images.previous")}
            </button>
            <button
              type="button"
              disabled={index === images.length - 1}
              onClick={() => step(1)}
            >
              {translateText("images.next")}
            </button>
          </span>
        ) : null}
      </div>
    </DialogContent>
  );
}

/** One picture, fetched from the host when the view left it out. */
function Picture({
  sessionId,
  image,
}: {
  sessionId: string | null | undefined;
  image: RunImage;
}) {
  const { t: translateText } = useTranslation("chat");
  const { src, failed } = useSessionImage(sessionId, image);
  if (src === undefined)
    return (
      <span className="image-pending">
        {failed ? translateText("images.failed") : sizeLabel(image)}
      </span>
    );
  return <img src={src} alt="" draggable={false} />;
}

/** The kind and size of a picture, as a caption: "PNG · 84 KB". */
function sizeLabel(image: RunImage): string {
  const kind = image.mimeType.replace(/^image\//, "").toUpperCase();
  const bytes = image.bytes ?? Math.floor((image.data.length * 3) / 4);
  if (bytes <= 0) return kind;
  const size =
    bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${kind} · ${size}`;
}
