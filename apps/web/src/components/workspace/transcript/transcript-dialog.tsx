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
 */
export function TranscriptDialog({
  trigger,
  open,
  onOpenChange,
  title,
  meta,
  description,
  quietDescription = false,
  bodyRef,
  bodyClassName,
  onBodyScroll,
  children,
}: {
  /** What opens it, when the dialog keeps its own open state. */
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: ReactNode;
  /** Beside the title, quieter: when, who. */
  meta?: ReactNode;
  /** Under the title; read out as the dialog's description. */
  description: ReactNode;
  /** The description is only read out: the title already says it. */
  quietDescription?: boolean;
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
      <DialogContent className="transcript-dialog flex h-[min(50rem,calc(100dvh-4rem))] w-[min(60rem,calc(100vw-4rem))] max-h-none max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none max-sm:inset-0 max-sm:h-dvh max-sm:w-screen max-sm:translate-x-0 max-sm:translate-y-0">
        <div className="shrink-0 space-y-0.5 border-b px-3 py-2 pr-11 max-sm:pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="flex items-baseline gap-2">
            <DialogTitle className="truncate">{title}</DialogTitle>
            {meta === undefined ? null : (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {meta}
              </span>
            )}
          </div>
          <DialogDescription
            className={
              quietDescription
                ? "sr-only"
                : "text-muted-foreground wrap-anywhere"
            }
          >
            {description}
          </DialogDescription>
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
