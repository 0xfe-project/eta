import type { ReactNode } from "react";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { Link } from "@tanstack/react-router";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTasks } from "@/queries/tasks";
import { AgentEditor } from "./agent-editor";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { GroupList } from "./groups";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { useAgents, useOpenAgent } from "./use-agents";
import { useAttention } from "./use-attention";

// Shared navigation: the full-window sidebar on wide screens and four
// bottom tabs on mobile. Conversation lists are the mobile home screen.

const sections = [
  { to: "/", label: "对话", icon: ChatsCircleIcon },
  { to: "/workspace/inbox", label: "待处理", icon: BellIcon },
  { to: "/workspace/tasks", label: "任务", icon: ListChecksIcon },
  { to: "/workspace/routines", label: "定时", icon: ClockIcon },
  { to: "/workspace/memory", label: "记忆", icon: BrainIcon },
] as const;

/**
 * What each section holds for the user: everything waiting for them, and
 * tasks to accept.
 */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const { total } = useAttention();
  const { data } = useTasks();
  const review = data?.tasks.filter((t) => t.status === "in_review").length;
  return { "/workspace/tasks": review, "/workspace/inbox": total };
}

const item =
  "flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground transition-colors duration-[60ms] ease-linear outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";

function Badge({ count }: { count: number | undefined }) {
  return count ? (
    <span className="ml-auto text-xs text-foreground tabular-nums">
      {count}
    </span>
  ) : null;
}

export function Sidebar() {
  const badges = useBadges();
  const { agents, loaded, error, openEditor } = useAgents();
  const openAgent = useOpenAgent();
  return (
    <aside className="hidden w-48 shrink-0 flex-col overflow-y-auto border-r bg-sidebar md:flex lg:w-56">
      <div className="flex h-12 shrink-0 items-center justify-between pr-2 pl-4">
        <Link to="/workspace" className="text-lg font-semibold tracking-tight">
          axp.
        </Link>
        <SettingsButton />
      </div>
      <nav aria-label="分区" className="grid gap-px px-2">
        {sections.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={item}
            activeOptions={{ exact: to === "/", includeSearch: false }}
            activeProps={{
              className: "bg-sidebar-accent font-medium text-foreground",
            }}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
            <Badge count={badges[to]} />
          </Link>
        ))}
      </nav>
      <GroupList compact />
      <section
        aria-labelledby="sidebar-agents"
        className="mt-5 flex min-h-0 flex-col px-2"
      >
        <div className="flex h-7 items-center justify-between pl-2">
          <h2
            id="sidebar-agents"
            className="text-xs font-medium text-muted-foreground"
          >
            智能体
          </h2>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="新建智能体"
            title="新建智能体"
            onClick={() => openEditor()}
          >
            <PlusIcon aria-hidden="true" />
          </Button>
        </div>
        {error && !loaded ? (
          <p className="px-2 text-xs text-muted-foreground">无法加载智能体</p>
        ) : !loaded ? (
          <Loading rows={2} />
        ) : agents.length ? null : (
          <Empty
            title="还没有智能体"
            className="px-3 py-4"
            action={
              <Button size="xs" variant="outline" onClick={() => openEditor()}>
                新建智能体
              </Button>
            }
          />
        )}
        <ul className="grid min-h-0 gap-px overflow-y-auto">
          {agents.map((agent) => (
            <li key={agent.id}>
              <button
                type="button"
                onClick={() => openAgent(agent.id)}
                title={`与 ${agent.name} 对话`}
                className={cn(item, "w-full")}
              >
                <AgentAvatar agent={agent} className="size-5" />
                <span className="min-w-0 flex-1 truncate text-left">
                  {agent.name}
                </span>
                <AgentStatusDot status={agent.status} />
                <span className="sr-only">
                  {agentStatusLabels[agent.status]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

/** Mobile A: lists first, with a persistent bottom navigation outside a conversation. */
export function BottomNav() {
  const badges = useBadges();
  const tabs = [
    sections[0],
    sections[2],
    sections[1],
    { to: "/workspace", label: "更多", icon: ListChecksIcon },
  ] as const;
  return (
    <nav
      aria-label="分区"
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
    <div className="flex h-dvh min-h-0 bg-background">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        <BottomNav />
      </div>
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
