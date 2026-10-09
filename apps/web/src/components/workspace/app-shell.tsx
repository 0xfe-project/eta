import type { ReactNode } from "react";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { PuzzlePieceIcon } from "@phosphor-icons/react/PuzzlePiece";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePendingInteractions } from "@/queries/chat";
import { useTasks } from "@/queries/tasks";
import { AgentEditor } from "./agent-editor";
import { AgentMonogram, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { SettingsButton, SettingsDialog } from "./settings-dialog";
import { useAgents, useOpenAgent } from "./use-agents";
import { usePendingTitle } from "./use-pending-title";

// The full-window workspace (/workspace) around its pages: on wide screens
// a sidebar of sections and agents, on narrow ones a bar along the top. The
// conversation stays on the home page.

const sections = [
  { to: "/", label: "对话", icon: ChatsCircleIcon },
  { to: "/workspace/inbox", label: "确认", icon: BellIcon },
  { to: "/workspace/tasks", label: "任务", icon: ListChecksIcon },
  { to: "/workspace/routines", label: "定时", icon: ClockIcon },
  { to: "/workspace/memory", label: "记忆", icon: BrainIcon },
  { to: "/workspace/capabilities", label: "能力", icon: PuzzlePieceIcon },
] as const;

/** What each section holds for the user: confirmations, tasks to accept. */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const pending = usePendingInteractions().length;
  const { data } = useTasks();
  const review = data?.tasks.filter((t) => t.status === "in_review").length;
  return { "/workspace/tasks": review, "/workspace/inbox": pending };
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

function Sidebar() {
  const badges = useBadges();
  const { agents, loaded, openEditor } = useAgents();
  const openAgent = useOpenAgent();
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-sidebar lg:flex">
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
      {loaded ? (
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
          <ul className="grid min-h-0 gap-px overflow-y-auto">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => openAgent(agent.id)}
                  title={`与 ${agent.name} 对话`}
                  className={cn(item, "w-full")}
                >
                  <AgentMonogram agent={agent} className="size-5 text-[10px]" />
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
      ) : null}
    </aside>
  );
}

/** Narrow screens: the sections as icons along the top. */
function TopBar() {
  const badges = useBadges();
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 px-4 sm:px-6 lg:hidden">
      <Link
        to="/workspace"
        className="mr-auto text-xl font-semibold tracking-tight"
      >
        axp.
      </Link>
      <nav aria-label="分区" className="flex">
        {sections.map(({ to, label, icon: Icon }) => (
          <Button key={to} variant="ghost" size="icon" asChild>
            <Link
              to={to}
              aria-label={badges[to] ? `${label}（${badges[to]}）` : label}
              title={label}
              activeOptions={{ exact: to === "/", includeSearch: false }}
              activeProps={{ className: "bg-muted" }}
              className="relative"
            >
              <Icon aria-hidden="true" />
              {badges[to] ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 right-1.5 size-1.5 bg-foreground"
                />
              ) : null}
            </Link>
          </Button>
        ))}
      </nav>
      <SettingsButton />
    </header>
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
  usePendingTitle();
  return (
    <div className="flex h-dvh min-h-0 bg-background">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar />
        {children}
      </div>
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
