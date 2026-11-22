import { Tooltip as TooltipPrimitive } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/** One picture as the preview and the lightbox show it: the picture itself and its caption. */
export interface ViewedPicture {
  key: string;
  /** "image.png · 24.6 KB", or "PNG · 84 KB" for a picture with no name. */
  caption: string;
  view: React.ReactNode;
}

/**
 * The picture behind `children`, shown beside it once the pointer has rested on it or the keyboard
 * has focused it, and gone the moment either leaves. A touch opens nothing here: a tap is a click,
 * which opens the lightbox. The preview takes no pointer, so it cannot hold itself open.
 */
export function PicturePreview({
  picture,
  children,
}: {
  picture: ViewedPicture;
  children: React.ReactElement;
}) {
  return (
    // Its own provider: the app's opens tooltips at once, a picture waits for the pointer to rest.
    <TooltipPrimitive.Provider delayDuration={200} disableHoverableContent>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="start"
            sideOffset={6}
            collisionPadding={8}
            className="picture-preview"
          >
            {picture.view}
            <span className="picture-preview-caption">{picture.caption}</span>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * Pictures over the whole window: the one at `open` fitted to the screen, at its own size once
 * clicked, the arrow keys walking through the rest.
 */
export function Lightbox({
  pictures,
  open,
  onOpen,
}: {
  pictures: readonly ViewedPicture[];
  open: number | undefined;
  onOpen: (index: number | undefined) => void;
}) {
  return (
    <Dialog
      open={open !== undefined}
      onOpenChange={(next) => {
        if (!next) onOpen(undefined);
      }}
    >
      {open === undefined ? null : (
        <LightboxContent pictures={pictures} index={open} onIndex={onOpen} />
      )}
    </Dialog>
  );
}

function LightboxContent({
  pictures,
  index,
  onIndex,
}: {
  pictures: readonly ViewedPicture[];
  index: number;
  onIndex: (index: number) => void;
}) {
  const { t: translateText } = useTranslation("chat");
  const [actual, setActual] = useState(false);
  const picture = pictures[index]!;
  const step = (by: number) => {
    const next = index + by;
    if (next < 0 || next >= pictures.length) return;
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
          count: pictures.length,
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
        {picture.view}
      </div>
      <div className="lightbox-bar">
        <span className="min-w-0 truncate">
          {pictures.length > 1 ? `${index + 1} / ${pictures.length} · ` : ""}
          {picture.caption}
        </span>
        {pictures.length > 1 ? (
          <span className="flex shrink-0 gap-3">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => step(-1)}
            >
              {translateText("images.previous")}
            </button>
            <button
              type="button"
              disabled={index === pictures.length - 1}
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
