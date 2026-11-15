import type { ReactNode, Ref } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * A whole run read in one place: a task run's log, a group reply's process.
 *
 * The frame is the same size whatever is in it — 960 by 800 at most, the window less 4rem when
 * that is smaller — so a log that grows while it is read, or a short one opened after a long one,
 * does not move the frame under the reader. On a phone it is the whole screen: a long list in a
 * floating card leaves a thumb's width to read it in. The header stays; the body scrolls.
 *
 * The header is what the caller draws (who ran it, how it went, where the time went); the dialog's
 * name is `title`, for a screen reader only: the button that opened it already said it.
 */
export function TranscriptDialog({
  trigger,
  open,
  onOpenChange,
  title,
  header,
  description,
  bodyRef,
  bodyClassName,
  onBodyScroll,
  children,
}: {
  /** What opens it, when the dialog keeps its own open state. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The dialog's accessible name; not shown. */
  title: string;
  /** The visible top. The close button sits at its top right: the first line leaves room for it. */
  header: ReactNode;
  /** Read out as the dialog's description; not shown. */
  description?: string | undefined;
  bodyRef?: Ref<HTMLDivElement>;
  bodyClassName?: string;
  onBodyScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger === undefined ? null : (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      )}
      <DialogContent
        {...(description === undefined
          ? { "aria-describedby": undefined }
          : {})}
        className="transcript-dialog flex h-[min(50rem,calc(100dvh-4rem))] w-[min(60rem,calc(100vw-4rem))] max-h-none max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-sm:inset-0 max-sm:h-dvh max-sm:w-screen max-sm:translate-x-0 max-sm:translate-y-0"
      >
        <div className="shrink-0 border-b px-3 py-2 max-sm:pt-[max(0.5rem,env(safe-area-inset-top))]">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          {description === undefined ? null : (
            <DialogDescription className="sr-only">
              {description}
            </DialogDescription>
          )}
          {header}
        </div>
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className={cn(
            "min-h-0 flex-1 overflow-y-auto p-3 max-sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
