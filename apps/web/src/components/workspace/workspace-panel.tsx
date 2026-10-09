import type { WorkspaceView } from "./types";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { usePendingInteractions } from "@/queries/chat";
import { CapabilitiesView } from "./capabilities-view";
import { Inbox } from "./inbox";
import { MemoryView } from "./memory-view";
import { Overview } from "./overview";
import { useRoutineNav } from "./routine-nav";
import { Routines } from "./routines";
import { useTaskNav } from "./task-nav";
import { Tasks } from "./tasks";
import { hasPage, sectionPaths, views } from "./workspace-search";

/** The home page's side panel; most tabs also open in the full window. */
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
  const label = views.find((v) => v.value === view)?.label;
  // The full window opens where the panel is.
  const [{ task }] = useTaskNav();
  const [routineNav] = useRoutineNav();
  const search = Object.fromEntries(
    Object.entries(
      view === "tasks" ? { task } : view === "routines" ? routineNav : {},
    ).filter(([, value]) => value !== null),
  );
  return (
    <Tabs
      id="workspace-panel"
      value={view}
      onValueChange={(value) => onViewChange(value as WorkspaceView)}
      className={cn(
        "relative z-10 min-h-0 min-w-0 gap-0 overflow-hidden border border-border/70 bg-background shadow-[0_2px_4px_-2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.12)] lg:border-y-0 lg:border-r-0 lg:border-border lg:shadow-none dark:shadow-[0_2px_4px_-2px_rgb(0_0_0/0.2),0_12px_32px_-8px_rgb(0_0_0/0.4)] dark:lg:shadow-none",
        className,
      )}
    >
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1 px-3 pt-3">
        <span aria-hidden="true" />
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
        {hasPage(view) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="justify-self-end"
            asChild
          >
            <Link
              to={sectionPaths[view]}
              search={search}
              aria-label={`在全窗口中打开${label}`}
              title="在全窗口中打开"
            >
              <ArrowsOutIcon aria-hidden="true" />
            </Link>
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {views.map(({ value }) => (
          <TabsContent key={value} value={value}>
            {value === "overview" ? <Overview /> : null}
            {value === "tasks" ? <Tasks /> : null}
            {value === "routines" ? <Routines /> : null}
            {value === "memory" ? <MemoryView /> : null}
            {value === "capabilities" ? <CapabilitiesView /> : null}
            {value === "inbox" ? <Inbox /> : null}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
