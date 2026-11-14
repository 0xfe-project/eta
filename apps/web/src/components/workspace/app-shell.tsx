import type { EmailAccountStatus } from "@eta/client-contracts";
import type { Icon } from "@phosphor-icons/react";
import type { CSSProperties, ReactNode } from "react";
import type { PaneWidth } from "./pane";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
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
import { useEmail, useVerifyEmailAccount } from "@/queries/email";
import { useTasks } from "@/queries/tasks";
import { AgentEditor } from "./agent-editor";
import { NewConversationDialog } from "./new-conversation-dialog";
import { usePaneWidth } from "./pane";
import { SettingsDialog, SettingsMenuItem } from "./settings-dialog";
import { CaptainSection, ConversationList } from "./sidebar-tree";
import { useWorkspaceStore } from "./workspace-store";

// Shared navigation: the full-window sidebar on wide screens and the destinations plus the main
// action in the middle on the phone. The conversation list is the mobile home screen.

const sections = [
  {
    to: "/",
    get label() {
      return translate("navigation:sections.chat");
    },
    icon: ChatsCircleIcon,
  },
  {
    to: "/tasks",
    get label() {
      return translate("navigation:sections.tasks");
    },
    icon: ListChecksIcon,
  },
  {
    to: "/email",
    get label() {
      return translate("navigation:sections.email");
    },
    icon: EnvelopeSimpleIcon,
  },
  {
    to: "/routines",
    get label() {
      return translate("navigation:sections.routines");
    },
    icon: ClockIcon,
  },
] as const;

/** The sections this build offers: Routine keeps its entry only where the feature is on. */
const shownSections = sections.filter(
  (section) => ROUTINES_VISIBLE || section.to !== "/routines",
);

/** What each section holds for the user: tasks to accept. */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const { tasks } = useTasks();
  const { stats } = useEmail();
  return {
    "/tasks": tasks.filter((t) => t.status === "in_review").length,
    "/email": stats.unread,
  };
}

const MAILBOX_STATUS = {
  ready: "email:accountStatus.ready",
  error: "email:accountStatus.error",
  unverified: "email:accountStatus.unverified",
} as const;

/**
 * What the Mailbox row has to say about the accounts behind it, and the way to try again.
 *
 * The row is one destination, so the accounts are one state: if every one is ready, it is Connected,
 * anything else is not. Connection error wins over Pending check — a failure is the one a person has to act on,
 * while an account nobody has checked yet is only a question. The button checks every account that
 * is not ready, in turn: a failed check comes back as the account's own state, so there is nothing
 * here to catch but the wire itself.
 */
function useMailboxRow(): {
  status: EmailAccountStatus | undefined;
  checking: boolean;
  reconnect: () => Promise<void>;
} {
  const { accounts } = useEmail();
  const verify = useVerifyEmailAccount();
  const [checking, setChecking] = useState(false);
  const status: EmailAccountStatus | undefined =
    accounts.length === 0
      ? undefined
      : accounts.every((account) => account.status === "ready")
        ? "ready"
        : accounts.some((account) => account.status === "error")
          ? "error"
          : "unverified";
  const reconnect = async () => {
    if (checking) return;
    setChecking(true);
    try {
      for (const account of accounts.filter(
        (candidate) => candidate.status !== "ready",
      )) {
        await verify
          .mutateAsync({ accountId: account.id })
          .catch(() => undefined);
      }
    } finally {
      setChecking(false);
    }
  };
  return { status, checking, reconnect };
}

export function Sidebar({
  resize,
}: {
  /** The drag on the column's right edge, from `SidebarShell`. */
  resize?: PaneWidth["dividerProps"];
}) {
  const { t: translateText } = useTranslation(["navigation", "email"] as const);
  const { state, isMobile, toggleSidebar } = useSidebar();
  const badges = useBadges();
  const mailbox = useMailboxRow();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The rail: the width 4rem of icons, and the same tree in it. Not the agent shelf's fold — that
  // one is the workspace store's, and the two never meet.
  const rail = state === "collapsed" && !isMobile;
  return (
    <SidebarRoot
      collapsible="icon"
      // `sidebar-rule`, not the component's default `border-r`: the rule is drawn top to bottom
      // everywhere except a folded rail in the shell, where its top would cut the window's lights
      // (`data-rail-edge`, see `styles.css`). The zero is the same `group-data-[side=left]`
      // variant, because a bare `border-r-0` does not win the merge against
      // `group-data-[side=left]:border-r`.
      data-rail-edge={rail ? "true" : undefined}
      className="sidebar-rule group-data-[side=left]:border-r-0 hidden shrink-0 md:flex"
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
        {/* Captain first, above the destinations and above the list: the whole sidebar is what it
            watches over, so it is the one thing here that does not move. */}
        <CaptainSection rail={rail} />
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
              // Mailbox is the one destination whose page can be right there and useless, because the
              // account behind it is not reachable — so it is the one row that says how it is.
              const mail = to === "/email" ? mailbox : undefined;
              const health =
                mail?.status === undefined
                  ? undefined
                  : translateText(MAILBOX_STATUS[mail.status]);
              const name = count ? `${label} · ${count}` : label;
              // Conversation is the home row: `startsWith("/")` is true from every section, so it is lit by
              // the home path alone. The other rows keep the prefix match.
              const active =
                to === "/" ? pathname === "/" : pathname.startsWith(to);
              return (
                <SidebarMenuItem key={to}>
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={label}
                    className={cn(
                      "relative overflow-visible text-sm",
                      rail && "mx-auto",
                    )}
                  >
                    <Link
                      to={to}
                      aria-label={
                        health === undefined ? name : `${name} · ${health}`
                      }
                    >
                      <Icon aria-hidden="true" />
                      {rail ? null : <span>{label}</span>}
                      {/* The state rides in the row, in the flow: it is what the label leads to
                          a question about, and `pr-8` is already reserved for the button beside
                          it by the row's own action. */}
                      {rail || health === undefined ? null : (
                        <span
                          data-slot="mailbox-health"
                          className={cn(
                            "ml-auto shrink-0 font-mono text-[10px] text-muted-foreground",
                            // The unread count keeps the row's right edge; the state steps
                            // left of it rather than under it.
                            count && "mr-6",
                          )}
                        >
                          {health}
                        </span>
                      )}
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
                      {/* 4rem holds the icon and nothing beside it, so the state is a mark on the
                          icon — and the link's name is where it is said. */}
                      {rail && mail?.status !== undefined ? (
                        <span
                          data-slot="mailbox-dot"
                          aria-hidden="true"
                          className={cn(
                            "absolute -right-1 -bottom-1 size-1.5 border border-sidebar",
                            mail.status === "error"
                              ? "bg-destructive"
                              : "bg-muted-foreground",
                          )}
                        />
                      ) : null}
                    </Link>
                  </SidebarMenuButton>
                  {!rail && count ? (
                    <SidebarMenuBadge
                      className={health === undefined ? undefined : "right-7"}
                    >
                      {count}
                    </SidebarMenuBadge>
                  ) : null}
                  {rail || mail?.status === undefined ? null : (
                    <SidebarMenuAction
                      aria-label={translateText("email:reconnect")}
                      title={translateText("email:reconnect")}
                      // Nothing to reconnect is not a failure: the row says Connected and this is the
                      // door that stays shut until something is actually wrong.
                      disabled={mail.checking || mail.status === "ready"}
                      onClick={() => void mail.reconnect()}
                    >
                      <ArrowsClockwiseIcon
                        aria-hidden="true"
                        className={cn(
                          "size-3.5",
                          mail.checking && "motion-safe:animate-spin",
                        )}
                      />
                    </SidebarMenuAction>
                  )}
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
      {/* Inside the column, not beside it: a gutter in the row would add a pixel to the layout and
          a second line next to `sidebar-rule`, and this one rides the fold's animation with the
          edge it sits on. The rail has no width to choose, so it has no line to drag. */}
      {resize === undefined || rail ? null : (
        <div
          aria-label={translateText("accessibility.resizeSidebar")}
          className="pane-divider sidebar-divider hidden md:block"
          {...resize}
        />
      )}
    </SidebarRoot>
  );
}

const WIDE_SIDEBAR = "(min-width: 64rem)";

/** Whether `styles.css` has the sidebar at its wide default, kept in step with the window. */
function useWideSidebar() {
  return useSyncExternalStore(
    (changed) => {
      const media = window.matchMedia(WIDE_SIDEBAR);
      media.addEventListener("change", changed);
      return () => media.removeEventListener("change", changed);
    },
    () => window.matchMedia(WIDE_SIDEBAR).matches,
  );
}

/**
 * The window's row: the provider, the left column, and the width the two share. The workspace and
 * the full-window pages each mount one, so a width dragged on one is there on the other.
 *
 * The bounds are the ones the layout can actually hold: below 260px a folder path and a
 * conversation name cannot share a row; above 420px the column starts competing with the chat,
 * which is the thing being read.
 *
 * Nobody who has not dragged gets a width written for them: the default stays the stylesheet's, 16rem
 * and 18rem from `lg`, and the fallback is those two in pixels (256 is under the drag's floor on
 * purpose), there for the drag to start from.
 */
export function SidebarShell({ children }: { children: ReactNode }) {
  const pane = usePaneWidth({
    storageKey: "eta.sidebar.width",
    min: 260,
    max: 420,
    fallback: useWideSidebar() ? 288 : 256,
    edge: "left",
  });
  return (
    <SidebarProvider
      className="h-dvh min-h-0 bg-background"
      data-sidebar-sized={pane.sized ? "true" : undefined}
      data-sidebar-dragging={pane.dragging ? "true" : undefined}
      style={
        pane.sized
          ? ({ "--sidebar-width": `${pane.width}px` } as CSSProperties)
          : undefined
      }
    >
      <Sidebar resize={pane.dividerProps} />
      {children}
    </SidebarProvider>
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
    <>
      <nav
        aria-label={translateText("accessibility.sections")}
        // A board, not an edge. The bar is a bordered plate inset from the screen on every side, and
        // what is left under it is the safe area's floor — empty, and outside the plate rather than
        // padding inside it, so a change of inset moves the floor and not the bar.
        className="shrink-0 px-[8px] pb-[var(--bottom-inset)] md:hidden"
      >
        {/* Destinations of one width, the plus in a cell of its own: the solid square is the axis
          the tabs are read against, and it breaks the plate's edge above and below, which is what
          makes it a bigger thing than the tabs beside it rather than one of them. Routine keeps a
          cell only where the feature is on; with three destinations the four cells are equal. */}
        <div className="relative h-[52px] border bg-background">
          <div
            className={cn(
              "grid h-full grid-rows-1",
              ROUTINES_VISIBLE
                ? "grid-cols-[1fr_1fr_1fr_68px_1fr_1fr]"
                : "grid-cols-[1fr_1fr_1fr_68px_1fr]",
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
            <Tab
              to="/email"
              label={translateText("sections.email")}
              icon={EnvelopeSimpleIcon}
              badge={badges["/email"]}
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
    </>
  );
}

/** One destination in the phone's bottom bar. */
function Tab({
  to,
  label,
  icon: Icon,
  badge,
}: {
  to: "/" | "/tasks" | "/email" | "/routines" | "/settings";
  label: string;
  icon: Icon;
  badge?: number | undefined;
}) {
  return (
    <Link
      to={to}
      search={{}}
      className="flex min-w-0 flex-col items-center justify-center gap-1 text-xs"
      activeOptions={{ exact: true, includeSearch: false }}
      activeProps={{ className: "text-foreground bg-muted/50" }}
      inactiveProps={{ className: "text-muted-foreground" }}
    >
      <Icon className="size-5" aria-hidden="true" />
      <span className="max-w-full truncate px-1">
        {badge ? `${label} · ${badge}` : label}
      </span>
    </Link>
  );
}

/**
 * The phone's main action, in the middle cell: starting a conversation, alone or with several.
 *
 * A solid square in the theme's inverse (`bg-foreground text-background`): the theme flips those
 * two, so the axis stays an axis in both themes without a second set of colours.
 */
function NewAction() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  const setNewConversation = useWorkspaceStore((s) => s.setNewConversation);
  return (
    <button
      type="button"
      aria-label={translateText("actions.new")}
      title={translateText("actions.new")}
      aria-haspopup="dialog"
      onClick={() => setNewConversation({ open: true })}
      className="flex size-[68px] items-center justify-center bg-foreground text-background outline-none hover:bg-foreground/90 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <PlusIcon aria-hidden="true" weight="bold" className="size-7" />
    </button>
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
    // The band, like the chat's header and the sidebar's: one height, one field, one rule under
    // it, so moving between pages never moves the line.
    <div className="band gap-2 px-4 sm:px-6">
      <h1 className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold">
        {title}
      </h1>
      {children}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SidebarShell>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        <BottomNav />
      </div>
      <SettingsDialog />
      <AgentEditor />
      <NewConversationDialog />
    </SidebarShell>
  );
}
