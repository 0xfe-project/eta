import type { ReactNode } from "react";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
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
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { ConversationList } from "./sidebar-tree";
import { useAgents, useOpenAgent } from "./use-agents";

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

const groupLabel = "text-xs font-medium text-muted-foreground";

export function Sidebar() {
  const { t: translateText } = useTranslation([
    "navigation",
    "agents",
    "chat",
    "common",
  ] as const);
  const badges = useBadges();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { agents, loaded, error, openEditor } = useAgents();
  const openAgent = useOpenAgent();
  return (
    <SidebarRoot
      collapsible="none"
      className="hidden shrink-0 border-r [--sidebar-width:12rem] md:flex lg:[--sidebar-width:14rem]"
    >
      <SidebarHeader className="band flex-row items-center justify-between p-0 pr-2 pl-4">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          eta.
        </Link>
        <SettingsButton />
      </SidebarHeader>
      <SidebarContent className="gap-0">
        <SidebarGroup className="pb-0">
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
        <SidebarGroup aria-labelledby="sidebar-agents">
          <SidebarGroupLabel id="sidebar-agents" className={groupLabel}>
            {translateText("common:entities.agents")}
          </SidebarGroupLabel>
          <SidebarGroupAction
            aria-label={translateText("agents:actions.create")}
            title={translateText("agents:actions.create")}
            onClick={() => openEditor()}
          >
            <PlusIcon aria-hidden="true" />
          </SidebarGroupAction>
          {error && !loaded ? (
            <p className="px-2 text-xs text-muted-foreground">
              {translateText("agents:errors.loadFailed")}
            </p>
          ) : !loaded ? (
            <Loading rows={2} />
          ) : agents.length ? null : (
            <Empty
              title={translateText("agents:empty.title")}
              className="px-3 py-4"
              action={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => openEditor()}
                >
                  {translateText("agents:actions.create")}
                </Button>
              }
            />
          )}
          <SidebarMenu>
            {agents.map((agent) => (
              <SidebarMenuItem key={agent.id}>
                <SidebarMenuButton
                  onClick={() => openAgent(agent.id)}
                  title={translateText("agents:actions.chatWith", {
                    name: agent.name,
                  })}
                  className="text-sm"
                >
                  <AgentAvatar agent={agent} className="size-5" />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <AgentStatusDot status={agent.status} />
                  <span className="sr-only">
                    {agentStatusLabels[agent.status]}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
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
    </SidebarProvider>
  );
}
