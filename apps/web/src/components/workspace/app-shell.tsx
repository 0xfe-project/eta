import type { ReactNode } from "react";
import { ChatsCircleIcon } from "@phosphor-icons/react/ChatsCircle";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Empty, Loading } from "@/components/states";
import { Button } from "@/components/ui/button";
import { translate } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AgentEditor } from "./agent-editor";
import { AgentAvatar, AgentStatusDot } from "./agent-identity";
import { agentStatusLabels } from "./agent-status";
import { SettingsDialog } from "./settings-dialog";
import { SidebarPane } from "./sidebar-pane";
import { FolderTree } from "./sidebar-tree";
import { useAgents, useOpenAgent } from "./use-agents";
import { useAttention } from "./use-attention";
import { useWorkspaceStore } from "./workspace-store";

// Shared navigation: the full-window sidebar on wide screens and four
// bottom tabs on mobile. Conversation lists are the mobile home screen.

/**
 * The one global entry.
 *
 * Everything else in this product belongs somewhere: a conversation, a folder, a member. Tasks,
 * routines and pending questions are facts about a group, so they are shown where that group is
 * (the right panel, the top of the chat) rather than as four destinations that each answer "and
 * which group?". What is left is a single place that looks across all of them — 总览.
 */
const sections = [
  {
    to: "/workspace",
    get label() {
      return translate("navigation:sections.overview");
    },
    icon: SquaresFourIcon,
  },
] as const;

/**
 * What 总览 holds for the user: everything waiting on them, wherever it is.
 *
 * One number, because there is one entry. The breakdown lives inside the overview (which knows
 * which group each item belongs to), and the group-scoped counts live on the groups themselves.
 */
function useBadges(): Partial<Record<(typeof sections)[number]["to"], number>> {
  const { total } = useAttention();
  return { "/workspace": total };
}

const item =
  "flex h-8 items-center gap-2 px-2 text-sm text-muted-foreground duration-[60ms] ease-linear outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none";

function Badge({ count }: { count: number | undefined }) {
  return count ? (
    <span className="ml-auto text-xs text-foreground tabular-nums">
      {count}
    </span>
  ) : null;
}

export function Sidebar({ width }: { width?: number } = {}) {
  const { t: translateText } = useTranslation([
    "navigation",
    "agents",
    "chat",
    "common",
  ] as const);
  const badges = useBadges();
  const [query, setQuery] = useState("");
  return (
    <aside
      // Sized by the divider (sidebar-pane.tsx) once the user has dragged it; the default is what
      // a first visit gets.
      style={width === undefined ? undefined : { width }}
      className={cn(
        "hidden shrink-0 flex-col overflow-y-auto border-r bg-surface md:flex",
        width === undefined && "w-48 lg:w-56",
      )}
    >
      {/* The left end of the one header band (styles.css, `.band`): same height, same field,
          same rule under it as the chat column and the panel. */}
      <div className="band pr-2 pl-4">
        <Link to="/" className="text-lg font-semibold tracking-tight">
          eta.
        </Link>
      </div>
      <nav
        aria-label={translateText("accessibility.sections")}
        className="grid gap-px px-2"
      >
        {sections.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className={item}
            activeOptions={{ exact: false, includeSearch: false }}
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
      {/* Starting a conversation lives next to finding one: both are about the list. */}
      <div className="flex items-center gap-1 px-2 pb-1">
        <label className="min-w-0 flex-1">
          <span className="sr-only">
            {translateText("chat:groups.search.placeholder")}
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={translateText("chat:groups.search.placeholder")}
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-full min-w-0 border border-border bg-transparent px-2 text-xs outline-none placeholder:text-faint focus:border-border-strong"
          />
        </label>
      </div>
      <FolderTree query={query} />
      <AgentLibrary />
      {/*
       * eta-old's settings entry: the sidebar's last row, the word 设置, a line above it. The
       * panel and the header both used to carry gear icons — three doors into one room, two of
       * them pointing at a different place than the third.
       */}
      <div className="mt-auto shrink-0 border-t border-border px-2 pt-2 pb-3">
        <button
          type="button"
          onClick={() =>
            useWorkspaceStore
              .getState()
              .setSettings((state) => ({ ...state, open: true }))
          }
          className="flex w-full items-center px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
        >
          {String(translateText("common:actions.settings"))}
        </button>
      </div>
    </aside>
  );
}

/**
 * The agents you cannot reach from the tree yet.
 *
 * A conversation is the thing this sidebar lists, and an agent with a direct chat already has a
 * row there — under its folder, next to the groups. Listing it again here would be the same
 * agent twice, which is how a list starts lying about how much there is.
 *
 * So this is not "all agents": it is the ones with no conversation anywhere, i.e. the ones that
 * would otherwise be unreachable. Pressing one opens its chat, which puts it in the tree and out
 * of this list — the list emptying as you work through it is the point.
 */
function AgentLibrary() {
  const { t: translateText } = useTranslation(["agents", "common"] as const);
  const { agents, loaded, error, openEditor } = useAgents();
  const openAgent = useOpenAgent();
  const library = agents;
  return (
    <section
      aria-labelledby="sidebar-agents"
      className="mt-2 flex min-h-0 shrink-0 flex-col border-t border-border px-2 pt-3 pb-2"
    >
      <div className="flex h-7 items-center justify-between pl-2">
        <h2
          id="sidebar-agents"
          className="font-mono text-[10px] tracking-[0.12em] text-faint uppercase"
        >
          {translateText("agents:library.title")}
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={translateText("agents:actions.create")}
          title={translateText("agents:actions.create")}
          onClick={() => openEditor()}
        >
          <PlusIcon aria-hidden="true" />
        </Button>
      </div>
      {error && !loaded ? (
        <p className="px-2 text-xs text-muted-foreground">
          {translateText("agents:errors.loadFailed")}
        </p>
      ) : !loaded ? (
        <Loading rows={1} />
      ) : agents.length === 0 ? (
        <Empty
          title={translateText("agents:empty.title")}
          className="px-3 py-3"
          action={
            <Button size="xs" variant="outline" onClick={() => openEditor()}>
              {translateText("agents:actions.create")}
            </Button>
          }
        />
      ) : (
        <ul className="grid min-h-0 grid-cols-1 gap-px overflow-y-auto">
          {library.map(
            (agent: { id: string; name: string; status: string }) => (
              <li key={agent.id}>
                <button
                  type="button"
                  onClick={() => openAgent(agent.id)}
                  title={translateText("agents:actions.chatWith", {
                    name: agent.name,
                  })}
                  className={cn(item, "w-full")}
                >
                  <AgentAvatar agent={agent} className="size-5" />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {agent.name}
                  </span>
                  <AgentStatusDot status={agent.status as never} />
                  <span className="sr-only">
                    {agentStatusLabels[agent.status]}
                  </span>
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

/**
 * Mobile A: lists first, with a persistent bottom navigation outside a
 * conversation. 更多 stays lit on the pages it leads to.
 */
export function BottomNav() {
  const { t: translateText } = useTranslation([
    "navigation",
    "agents",
    "common",
  ] as const);
  const badges = useBadges();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Three tabs, written out instead of picked from `sections` by index: the sidebar's list is
  // about looking across everything, the phone's is about the three things a thumb reaches for.
  // Indexing one list for both is how a tab silently starts leading somewhere else.
  const tabs = [
    {
      to: "/",
      label: translateText("sections.chat"),
      icon: ChatsCircleIcon,
      also: [] as string[],
    },
    {
      to: "/workspace/tasks",
      label: translateText("sections.tasks"),
      icon: ListChecksIcon,
      also: [] as string[],
    },
    {
      to: "/workspace/more",
      label: translateText("sections.more"),
      icon: DotsThreeIcon,
      also: [
        "/workspace",
        "/workspace/routines",
        "/workspace/memory",
        "/workspace/inbox",
      ],
    },
  ] as const;
  return (
    <nav
      aria-label={translateText("accessibility.sections")}
      className="flex shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {tabs.map(({ to, label, icon: Icon, also }) => (
        <Link
          key={to}
          to={to}
          search={{}}
          className={cn(
            "flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-xs text-muted-foreground",
            (also as readonly string[]).includes(pathname) &&
              "bg-muted/50 text-foreground",
          )}
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
      <SidebarPane />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {children}
        <BottomNav />
      </div>
      <SettingsDialog />
      <AgentEditor />
    </div>
  );
}
