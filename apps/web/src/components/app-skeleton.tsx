import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { CardSkeleton, MessageSkeleton, Skeleton } from "@/components/states";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { cn } from "@/lib/utils";

// What the router shows while a page's code is still on its way: the window in the shape it is about
// to take, so the page lands on top of its own outline instead of on a blank screen. Nothing here
// comes from the workspace code — that is the chunk being waited for — so the measures are copied:
// the 40px band, the 16rem sidebar (18rem from lg), the 860px chat column, the phone's 3.5rem header,
// its 4.5rem rows and its 52px bottom bar. index.html draws the same window before any script runs
// and stays up through the first load (main.tsx loads the router before the first commit), so this
// one is for the later navigations that still have a chunk to fetch.
//
// No hold here, unlike Loading: the router's pendingMs is the wait.

/** The sidebar's fold, as ui/sidebar.tsx keeps it, read before any of it has loaded. */
function folded() {
  return (
    typeof document !== "undefined" &&
    /(?:^|;\s*)sidebar_state=false/.test(document.cookie)
  );
}

/** The right panel's width, as workspace.tsx's usePaneWidth keeps it (320–720, 400 by default). */
function panelWidth() {
  try {
    const stored = Number(localStorage.getItem("eta.panel.width"));
    return Number.isFinite(stored) && stored > 0
      ? Math.min(720, Math.max(320, Math.round(stored)))
      : 400;
  } catch {
    return 400;
  }
}

/** One sidebar row: a glyph and its name, or the glyph alone in the rail. */
function SideRows({
  rows,
  rail,
  className,
}: {
  rows: number;
  rail: boolean;
  className?: string;
}) {
  return Array.from({ length: rows }, (_, i) => (
    <div
      key={i}
      className={cn(
        "flex items-center gap-3 px-2",
        rail && "justify-center",
        className,
      )}
    >
      <Skeleton className="size-3.5 shrink-0" />
      {rail ? null : (
        <Skeleton className={["w-3/5", "w-2/5", "w-1/2", "w-2/3"][i % 4]} />
      )}
    </div>
  ));
}

/** A section heading in the sidebar: the mono caption, or nothing in the rail. */
function SideHeading({ rail }: { rail: boolean }) {
  return (
    <div className="flex h-6 items-center border-b px-2 pb-1 box-content">
      {rail ? null : <Skeleton className="h-2.5 w-12" />}
    </div>
  );
}

function SidebarSkeleton() {
  const rail = folded();
  return (
    <div
      data-rail={rail ? "true" : "false"}
      className={cn(
        "sidebar-rule hidden shrink-0 flex-col bg-sidebar md:flex",
        // In rem, not spacing steps: ui/sidebar.tsx's widths are rem, and a step here is 0.225rem.
        rail ? "w-[4rem]" : "w-[16rem] lg:w-[18rem]",
      )}
    >
      {/* Empty: in the shell the window's lights sit over this corner, and nothing knows yet
          whether they are there, so a wordmark here would either hide under them or jump. */}
      <div className="band" />
      <div className="shrink-0 border-b p-2 pb-1">
        <SideRows rows={ROUTINES_VISIBLE ? 4 : 3} rail={rail} className="h-8" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2 pb-0">
        <SideHeading rail={rail} />
        <div className="py-1.5">
          <SideRows rows={4} rail={rail} className="h-9" />
        </div>
      </div>
      <div className="mt-auto shrink-0 border-t p-2 pb-0">
        <SideHeading rail={rail} />
        <div className="py-1.5">
          <SideRows rows={2} rail={rail} className="h-9" />
        </div>
      </div>
      <div className="shrink-0 border-t p-1">
        <SideRows rows={1} rail={rail} className="h-8" />
      </div>
    </div>
  );
}

/** The phone's bottom bar, as the empty plate it sits on (app-shell.tsx's BottomNav). */
function BottomNavSkeleton() {
  return (
    <div className="shrink-0 px-[8px] pb-[var(--bottom-inset)] md:hidden">
      <div className="h-[52px] border bg-background" />
    </div>
  );
}

/** A full-window page's header (PageHeader) and a list under it. */
function PageBody() {
  return (
    <>
      <div className="flex h-12 shrink-0 items-center border-b px-4 sm:px-6">
        <Skeleton className="w-24" />
      </div>
      <div className="mx-auto min-h-0 w-full max-w-content flex-1 overflow-hidden px-2 py-2 sm:px-4">
        <SideRows rows={8} rail={false} className="h-9 gap-3" />
      </div>
    </>
  );
}

/** The workspace at "/": the phone's conversation list, or the chat column and the panel. */
function ChatColumns() {
  return (
    <>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col md:hidden">
        <div
          className="flex h-14 shrink-0 items-center px-5"
          data-window-drag
          data-lights-corridor
        >
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-3">
          <CardSkeleton rows={5} />
        </div>
        <BottomNavSkeleton />
      </div>
      <div className="hidden min-h-0 min-w-0 flex-1 flex-col md:flex">
        <div className="band px-3">
          <Skeleton className="w-32" />
        </div>
        {/* chat-panel.tsx's transcript: the same scroller padding, the same 860px column. */}
        <div className="min-h-0 flex-1 overflow-hidden py-4 pr-14 pl-6">
          <div className="mx-auto max-w-[860px]">
            <MessageSkeleton rows={4} />
          </div>
        </div>
        {/* The composer's box: `.input-area` around `.input-outer`, the editor's 44px and the
            toolbar's 37px inside a 1px frame. The extra top is the held-messages strip. */}
        <div
          data-skeleton="composer"
          className="shrink-0 px-4 pt-[11px] pb-[14px]"
        >
          <div className="mx-auto h-[83px] max-w-[860px] border border-border" />
        </div>
      </div>
      <div
        className="hidden w-(--panel-width) shrink-0 flex-col border-l bg-surface lg:flex"
        style={{ "--panel-width": `${panelWidth()}px` } as CSSProperties}
      >
        <div className="band" />
      </div>
    </>
  );
}

/**
 * The whole window, for the routes that bring their own shell: `chat` is the
 * workspace at "/", `page` the shell the full-window pages share.
 */
export function AppSkeleton({ content }: { content: "chat" | "page" }) {
  const { t: translateText } = useTranslation("common");
  return (
    <div role="status" className="flex h-dvh min-h-0 bg-background">
      <span className="sr-only">{translateText("states.loading")}</span>
      <SidebarSkeleton />
      {content === "chat" ? (
        <ChatColumns />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <PageBody />
          <BottomNavSkeleton />
        </div>
      )}
    </div>
  );
}

/** Only the page, for the routes under the shell: the sidebar is the real one and stays. */
export function PageSkeleton() {
  const { t: translateText } = useTranslation("common");
  return (
    <div role="status" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <span className="sr-only">{translateText("states.loading")}</span>
      <PageBody />
    </div>
  );
}
