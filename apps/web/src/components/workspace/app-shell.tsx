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
} from "@/components/ui/sidebar";
import { translate } from "@/lib/i18n";
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
  const badges = useBadges();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <SidebarRoot
      collapsible="none"
      className="hidden shrink-0 border-r [--sidebar-width:16rem] md:flex lg:[--sidebar-width:18rem]"
    >
      <SidebarHeader className="band flex-row items-center justify-between p-0 pr-2 pl-4">
        {/* BR1's wordmark: uppercase, tracked out, the letterforms doing the work. */}
        <Link
          to="/"
          className="font-mono text-base font-medium tracking-[0.18em]"
        >
          ETA
        </Link>
        <SettingsButton />
      </SidebarHeader>
      <SidebarContent className="gap-0 overflow-hidden">
        <SidebarGroup className="shrink-0 border-b pb-1">
          <SidebarMenu aria-label={translateText("accessibility.sections")}>
            {sections.map(({ to, label, icon: Icon }) => (
              <SidebarMenuItem key={to}>
                <SidebarMenuButton
                  asChild
                  isActive={pathname.startsWith(to)}
                  className="text-sm"
                >
                  <Link to={to}>
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
                {badges[to] ? (
                  <SidebarMenuBadge>{badges[to]}</SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            ))}
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
