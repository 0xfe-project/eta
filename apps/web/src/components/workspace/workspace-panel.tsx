import type { WorkspaceView } from "./types";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { usePendingInteractions } from "@/queries/chat";
import { Inbox } from "./inbox";
import { MemoryView } from "./memory-view";
import { Overview } from "./overview";
import { RefreshButton } from "./refresh-button";
import { useRoutineNav } from "./routine-nav";
import { Routines } from "./routines";
import { useTaskNav } from "./task-nav";
import { Tasks } from "./tasks";
import { useAgents } from "./use-agents";
import { hasPage, sectionPaths, views } from "./workspace-search";

/** Opens the full window where the side panel is: its tab, task or routine. */
function FullWindowButton({
  view,
  className,
}: {
  view: WorkspaceView;
  className?: string;
}) {
  const [{ task }] = useTaskNav();
  const [routineNav] = useRoutineNav();
  const search = Object.fromEntries(
    Object.entries(
      view === "tasks" ? { task } : view === "routines" ? routineNav : {},
    ).filter(([, value]) => value !== null),
  );
  return (
    <Button variant="ghost" size="icon" className={className} asChild>
      <Link
        to={hasPage(view) ? sectionPaths[view] : "/workspace"}
        search={hasPage(view) ? search : {}}
        aria-label="在全窗口中打开"
        title="在全窗口中打开"
      >
        <ArrowsOutIcon aria-hidden="true" />
      </Link>
    </Button>
  );
}

/** The home page's side panel. */
export function WorkspacePanel({
  view,
  onViewChange,
  className,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  className?: string;
}) {
  const pending = usePendingInteractions().length;
  const { current } = useAgents();
  return (
    <Tabs
      id="workspace-panel"
      value={view}
      onValueChange={(value) => onViewChange(value as WorkspaceView)}
      className={cn(
        "relative z-10 min-h-0 min-w-0 gap-0 overflow-hidden border border-border/70 bg-background shadow-[0_2px_4px_-2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.12)] dark:shadow-[0_2px_4px_-2px_rgb(0_0_0/0.2),0_12px_32px_-8px_rgb(0_0_0/0.4)]",
        className,
      )}
    >
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pt-3">
        <div className="justify-self-start">
          {view === "tasks" || view === "routines" ? (
            <RefreshButton resource={view} />
          ) : null}
        </div>
        <TabsList variant="default" aria-label="工作区标签" className="gap-1">
          {views.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="px-2 text-xs sm:px-3"
            >
              {label}
              {value === "inbox" && pending ? (
                <span className="tabular-nums">{pending}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <FullWindowButton view={view} className="justify-self-end" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {views.map(({ value }) => (
          <TabsContent key={value} value={value}>
            {value === "overview" ? <Overview /> : null}
            {value === "tasks" ? <Tasks /> : null}
            {value === "routines" ? <Routines /> : null}
            {value === "memory" ? <MemoryView agentId={current?.id} /> : null}
            {value === "inbox" ? <Inbox /> : null}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
