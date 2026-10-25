import type { Icon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  Sidebar as SidebarRoot,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { ROUTINES_VISIBLE } from "@/lib/features";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTasks } from "@/queries/tasks";
import { AgentEditor } from "./agent-editor";
import { CreateGroup } from "./groups";
import { NewConversationDialog } from "./new-conversation-dialog";
import { SettingsDialog, SettingsMenuItem } from "./settings-dialog";
import { ConversationList } from "./sidebar-tree";
import { useWorkspaceStore } from "./workspace-store";

// Shared navigation: the full-window sidebar on wide screens and the destinations plus the main
// action in the middle on the phone. The conversation list is the mobile home screen.

const sections = [
  {
    to: "/tasks",
    get label() {
      return translate("navigation:sections.tasks");
    },
    icon: ListChecksIcon,
  },
  {
    to: "/routines",
    get label() {
      return translate("navigation:sections.routines");
    },
    icon: ClockIcon,
  },
] as const;

/** The sections this build offers: 定时 keeps its entry only where the feature is on. */
const shownSections = sections.filter(
  (section) => ROUTINES_VISIBLE || section.to !== "/routines",
);

/** What each section holds for the user: tasks to accept. */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const { tasks } = useTasks();
  return {
    "/tasks": tasks.filter((t) => t.status === "in_review").length,
  };
}

export function Sidebar() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  const { state, isMobile, toggleSidebar } = useSidebar();
  const badges = useBadges();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The rail: the width 4rem of icons, and the same tree in it. Not the agent shelf's fold — that
  // one is the workspace store's, and the two never meet.
  const rail = state === "collapsed" && !isMobile;
  return (
    <SidebarRoot
      collapsible="icon"
      // `sidebar-rule`, not `border-r`: the rule down this edge starts under the band, so it never
      // runs through the window's lights inside the band. See `styles.css`.
      className="sidebar-rule hidden shrink-0 md:flex"
    >
      <SidebarHeader
        // Only the CSS reads this: a collapsed rail is 4rem wide, which on a desktop is where the
        // window's lights are, so the corner is theirs and the wordmark steps aside there.
        data-rail={rail ? "true" : "false"}
        className={cn(
          "band flex-row items-center p-0",
          rail ? "justify-center px-1" : "justify-between pr-2 pl-4",
        )}
      >
        <div className="flex min-w-0 items-center" data-brand>
          {/* In the shell the window paints its three lights over this corner (macOS) or the page
              paints them (Windows), so the slot holds their width and the wordmark starts clear
              of them. A browser tab has no lights, so the slot is not there at all — and the two
              have to stay in one group: `justify-between` would otherwise put the wordmark in
              the middle of the band. */}
          <span className="lights-slot" aria-hidden="true" />
          {/* BR1's wordmark: uppercase, tracked out, the letterforms doing the work. The rail
              keeps the same three letters, set to a size the rail can hold — and holds nothing
              beside them: 4rem of band is one element, not a wordmark and a control dividing it
              up. The band is a fixed 40px (the gutter paints its rule at that height), so
              stacking the two would break the line, not fit them. Folding the rail from its own
              name is what the click is for. */}
          <Link
            to="/"
            onClick={() => {
              if (rail) toggleSidebar();
            }}
            className={cn(
              "shrink-0 font-mono font-medium",
              rail
                ? "text-[10px] tracking-[0.08em] text-muted-foreground"
                : "text-base tracking-[0.18em]",
            )}
          >
            ETA
          </Link>
        </div>
        {rail ? null : (
          <SidebarTrigger
            aria-label={translateText("accessibility.toggleSidebar")}
          />
        )}
      </SidebarHeader>
      <SidebarContent className="gap-0 overflow-hidden">
        <SidebarGroup className="shrink-0 border-b pb-1">
          <SidebarMenu aria-label={translateText("accessibility.sections")}>
            {/* The fold, in the rail, at the head of the list it folds away with: the band above
                holds the wordmark alone, and this is where the eye already is when the rail is
                open. Expanded keeps the trigger in the header, where it has always been. */}
            {rail ? (
              <SidebarMenuItem>
                <SidebarTrigger
                  aria-label={translateText("accessibility.toggleSidebar")}
                  className={
                    // Same trap as the gear below: the button's own class is `inline-flex`, and an
                    // inline box does not take auto margins — so `mx-auto` alone leaves the icon
                    // hugging the rail's left edge. `flex` makes it a block flex row first.
                    "mx-auto flex size-6"
                  }
                />
              </SidebarMenuItem>
            ) : null}
            {shownSections.map(({ to, label, icon: Icon }) => {
              const count = badges[to];
              return (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={pathname.startsWith(to)}
                    tooltip={label}
                    className={cn(
                      "relative overflow-visible text-sm",
                      rail && "mx-auto",
                    )}
                  >
                    <Link
                      to={to}
                      aria-label={count ? `${label} · ${count}` : label}
                    >
                      <Icon aria-hidden="true" />
                      {rail ? null : <span>{label}</span>}
                      {/* The badge the menu hides in the rail, as a corner mark on the icon:
                          folded away is not a reason to lose a count. The number is drawn here and
                          carried in the link's name, so it is neither silent nor said twice. */}
                      {rail && count ? (
                        <span
                          data-slot="menu-badge-dot"
                          aria-hidden="true"
                          className="absolute -top-0.5 -right-1 border border-border bg-sidebar px-0.5 font-mono text-[9px] leading-3 text-foreground tabular-nums"
                        >
                          {count}
                        </span>
                      ) : null}
                    </Link>
                  </SidebarMenuButton>
                  {!rail && count ? (
                    <SidebarMenuBadge>{count}</SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
        <ConversationList />
      </SidebarContent>
      {/* Settings last, as its own group at the foot of the rail: it is not one of the destinations
          a person moves between, it is the door out of them — and a row at the end of a list is
          found by the eye that ran to the end. The rule above it is the group's, not a separator:
          the list above scrolls, this row does not. */}
      <SidebarFooter
        className={cn("shrink-0 border-t", rail ? "px-1 py-1" : "p-1")}
      >
        <SidebarMenu aria-label={translateText("accessibility.settings")}>
          <SidebarMenuItem>
            <SettingsMenuItem rail={rail} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </SidebarRoot>
  );
}

/**
 * Mobile: the conversation list first, with a persistent bottom navigation outside a
 * conversation.
 */
export function BottomNav() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  const badges = useBadges();
  return (
    <nav
      aria-label={translateText("accessibility.sections")}
      // A board, not an edge. The bar is a bordered plate inset from the screen on every side, and
      // what is left under it is the safe area's floor — empty, and outside the plate rather than
      // padding inside it, so a change of inset moves the floor and not the bar.
      className="shrink-0 px-[8px] pb-[var(--bottom-inset)] md:hidden"
    >
      {/* Destinations of one width, the plus in a cell of its own: the solid square is the axis
          the tabs are read against, and it breaks the plate's edge above and below, which is what
          makes it a bigger thing than the tabs beside it rather than one of them. 定时 keeps a
          cell only where the feature is on; with three destinations the four cells are equal. */}
      <div className="relative h-[52px] border bg-background">
        <div
          className={cn(
            "grid h-full",
            ROUTINES_VISIBLE
              ? "grid-cols-[1fr_1fr_68px_1fr_1fr]"
              : "grid-cols-4",
          )}
        >
          <Tab
            to="/"
            label={translateText("sections.chat")}
            icon={ChatsCircleIcon}
          />
          <Tab
            to="/tasks"
            label={translateText("sections.tasks")}
            icon={ListChecksIcon}
            badge={badges["/tasks"]}
          />
          <div className="flex items-center justify-center">
            <NewAction />
          </div>
          {ROUTINES_VISIBLE ? (
            <Tab
              to="/routines"
              label={translateText("sections.routines")}
              icon={ClockIcon}
            />
          ) : null}
          <Tab
            to="/settings"
            label={translateText("sections.settings")}
            icon={GearSixIcon}
          />
        </div>
      </div>
    </nav>
  );
}

/** One destination in the phone's bottom bar. */
function Tab({
  to,
  label,
  icon: Icon,
  badge,
}: {
  to: "/" | "/tasks" | "/routines" | "/settings";
  label: string;
  icon: Icon;
  badge?: number | undefined;
}) {
  return (
    <Link
      to={to}
      search={{}}
      className="flex min-w-0 flex-col items-center justify-center gap-1 text-xs text-muted-foreground"
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: "text-foreground bg-muted/50" }}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate px-1">
        {badge ? `${label} · ${badge}` : label}
      </span>
    </Link>
  );
}

/**
 * The phone's main action, in the middle cell: the two things one starts from here. The desktop
 * has a plus above each column — a conversation on the sidebar, a group on the list — and the
 * phone has one bar, so the plus asks which of the two it is rather than picking one for good.
 *
 * A solid square in the theme's inverse (`bg-foreground text-background`): the theme flips those
 * two, so the axis stays an axis in both themes without a second set of colours.
 */
function NewAction() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  const setNewConversation = useWorkspaceStore((s) => s.setNewConversation);
  const [choosing, setChoosing] = useState(false);
  const [group, setGroup] = useState(false);
  // Two rows the size of a thumb, not a menu the size of a cursor: a pointer picks from a menu,
  // a thumb needs a target it cannot miss. So the choice opens as a dialog, like every other
  // question the app asks.
  const rowClass =
    "flex h-[52px] w-full items-center gap-2 border px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring";
  const pick = (next: () => void) => {
    setChoosing(false);
    // After this dialog is gone: opening the next one in the same frame leaves its overlay
    // holding the pointer.
    requestAnimationFrame(next);
  };
  return (
    <>
      <button
        type="button"
        aria-label={translateText("actions.new")}
        title={translateText("actions.new")}
        aria-haspopup="dialog"
        aria-expanded={choosing}
        onClick={() => setChoosing(true)}
        className="flex size-[68px] items-center justify-center bg-foreground text-background outline-none hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PlusIcon aria-hidden="true" weight="bold" className="size-7" />
      </button>
      <Dialog open={choosing} onOpenChange={setChoosing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translateText("actions.new")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <button
              type="button"
              className={rowClass}
              onClick={() => pick(() => setNewConversation({ open: true }))}
            >
              <ChatsCircleIcon aria-hidden="true" className="size-4" />
              {translateText("actions.newConversation")}
            </button>
            <button
              type="button"
              className={rowClass}
              onClick={() => pick(() => setGroup(true))}
            >
              <UsersThreeIcon aria-hidden="true" className="size-4" />
              {translateText("actions.newGroup")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
      {/* Mounted on open, like the conversation dialog: a form left half filled in is not what the
          next open should show. */}
      {group ? <CreateGroup open onOpenChange={setGroup} /> : null}
    </>
  );
}

/** A full-window page's top bar: where you are, then what you can do. */
export function PageHeader({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 sm:px-6">
      <h1 className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold">
        {title}
      </h1>
      {children}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarProvider className="h-dvh min-h-0 bg-background">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        <BottomNav />
      </div>
      <SettingsDialog />
      <AgentEditor />
      <NewConversationDialog />
    </SidebarProvider>
  );
}
