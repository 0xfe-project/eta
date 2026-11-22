import type { RunImage } from "@eta/client-contracts";
import type { ViewedPicture } from "../picture-viewer";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionImage } from "@/queries/sessions";
import { Lightbox, PicturePreview } from "../picture-viewer";

/**
 * The pictures a message carried (a screenshot a tool read back, an image the user attached), as
 * thumbnails. Resting on a thumbnail shows the picture larger beside it; clicking it opens the
 * picture over the whole window (`Lightbox`).
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
  const pictures = images.map(
    (image): ViewedPicture => ({
      key: `${image.entryId}:${image.index}`,
      caption: sizeLabel(image),
      view: <Picture sessionId={sessionId} image={image} />,
    }),
  );
  return (
    <>
      <div className="image-strip">
        {pictures.map((picture, index) => (
          <PicturePreview key={picture.key} picture={picture}>
            <button
              type="button"
              className="image-thumb"
              aria-label={translateText("images.open", {
                index: index + 1,
                count: images.length,
              })}
              onClick={() => setOpen(index)}
            >
              {picture.view}
            </button>
          </PicturePreview>
        ))}
      </div>
      <Lightbox pictures={pictures} open={open} onOpen={setOpen} />
    </>
  );
}

/**
 * One picture, fetched from the host when the view left it out — once it is on screen: a log holds
 * every screenshot the run took, folded away in cards nobody has opened.
 */
function Picture({
  sessionId,
  image,
}: {
  sessionId: string | null | undefined;
  image: RunImage;
}) {
  const { t: translateText } = useTranslation("chat");
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (seen || element === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);
  const { src, failed } = useSessionImage(sessionId, image, seen);
  if (src === undefined)
    return (
      <span ref={ref} className="image-pending">
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
