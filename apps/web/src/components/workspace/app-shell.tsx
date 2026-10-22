import type { ReactNode } from "react";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  SidebarContent,
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
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useTasks } from "@/queries/tasks";
import { AgentEditor } from "./agent-editor";
import { NewConversationDialog } from "./new-conversation-dialog";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { ConversationList } from "./sidebar-tree";

// Shared navigation: the full-window sidebar on wide screens and three
// bottom tabs on mobile. The conversation list is the mobile home screen.

const sections = [
  {
    to: "/workspace/tasks",
    get label() {
      return translate("navigation:sections.tasks");
    },
    icon: ListChecksIcon,
  },
  {
    to: "/workspace/routines",
    get label() {
      return translate("navigation:sections.routines");
    },
    icon: ClockIcon,
  },
] as const;

/** What each section holds for the user: tasks to accept. */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const { tasks } = useTasks();
  return {
    "/workspace/tasks": tasks.filter((t) => t.status === "in_review").length,
  };
}

export function Sidebar() {
  const { t: translateText } = useTranslation(["navigation"] as const);
  const { state, isMobile } = useSidebar();
  const badges = useBadges();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The rail: the width 4rem of icons, and the same tree in it. Not the agent shelf's fold — that
  // one is the workspace store's, and the two never meet.
  const rail = state === "collapsed" && !isMobile;
  return (
    <SidebarRoot
      collapsible="icon"
      className="hidden shrink-0 border-r md:flex"
    >
      <SidebarHeader
        className={cn(
          "band flex-row items-center p-0",
          rail ? "justify-center gap-0.5 px-1" : "justify-between pr-2 pl-4",
        )}
      >
        {/* BR1's wordmark: uppercase, tracked out, the letterforms doing the work. The rail keeps
            the same three letters, set to a size the rail can hold. */}
        <Link
          to="/"
          className={cn(
            "shrink-0 font-mono font-medium",
            rail
              ? "text-[10px] tracking-[0.08em] text-muted-foreground"
              : "text-base tracking-[0.18em]",
          )}
        >
          ETA
        </Link>
        <SidebarTrigger
          aria-label={translateText("accessibility.toggleSidebar")}
          className={rail ? "size-6" : undefined}
        />
      </SidebarHeader>
      <SidebarContent className="gap-0 overflow-hidden">
        <SidebarGroup className="shrink-0 border-b pb-1">
          <SidebarMenu aria-label={translateText("accessibility.sections")}>
            {/* Settings first, in both states: a control that moves when the rail folds is a
                control you have to look for twice. */}
            <SidebarMenuItem>
              <SettingsButton
                withLabel={!rail}
                className={cn(
                  "relative",
                  rail
                    ? // `inline-flex` will not take an auto margin, so the gear is made a block flex
                      // row first: at 4rem the rail's centre is the only place it can sit.
                      "mx-auto flex"
                    : "w-full justify-start gap-2 px-2 font-normal",
                )}
              />
            </SidebarMenuItem>
            {sections.map(({ to, label, icon: Icon }) => {
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
  // Written out instead of picked from `sections`: the sidebar lists the pages, the phone adds
  // its home (the conversation list) in front. Indexing one list for both is how a tab silently
  // starts leading somewhere else.
  const tabs = [
    { to: "/", label: translateText("sections.chat"), icon: ChatsCircleIcon },
    ...sections.map(({ to, icon }) => ({
      to,
      label: translateText(
        to === "/workspace/tasks" ? "sections.tasks" : "sections.routines",
      ),
      icon,
    })),
  ] as const;
  return (
    <nav
      aria-label={translateText("accessibility.sections")}
      className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          search={{}}
          className="flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs text-muted-foreground"
          activeOptions={{ exact: true, includeSearch: false }}
          activeProps={{ className: "text-foreground bg-muted/50" }}
        >
          <Icon className="size-5" aria-hidden="true" />
          <span>
            {label}
            {badges[to as keyof typeof badges]
              ? ` · ${badges[to as keyof typeof badges]}`
              : ""}
          </span>
        </Link>
      ))}
    </nav>
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
