import type { WorkspaceView } from "./types";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GroupInfo } from "./groups";
import { Inbox } from "./inbox";
import { Overview } from "./overview";
import { RefreshButton } from "./refresh-button";
import { useRoutineNav } from "./routine-nav";
import { Routines } from "./routines";
import { SettingsButton } from "./settings-dialog";
import { useTaskNav } from "./task-nav";
import { Tasks } from "./tasks";
import { useAttention } from "./use-attention";
import { useGroups } from "./use-groups";
import { hasPage, sectionPaths, views } from "./workspace-search";

/** Opens the full window at the side panel's current data context. */
function FullWindowButton({ view }: { view: WorkspaceView }) {
  const [{ task }] = useTaskNav();
  const [routineNav] = useRoutineNav();
  const search = Object.fromEntries(
    Object.entries(
      view === "tasks" ? { task } : view === "routines" ? routineNav : {},
    ).filter(([, value]) => value !== null),
  );
  return (
    <Button variant="ghost" size="icon" asChild>
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

/**
 * The home page's side panel. A direct chat has no group info, so its panel
 * leaves the group tab out and shows the overview in its place, whatever
 * the URL says.
 */
export function WorkspacePanel({
  view: linked,
  onViewChange,
  className,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  className?: string;
}) {
  const pending = useAttention().total;
  const direct = useGroups().current?.kind === "direct";
  const tabs = direct ? views.filter((v) => v.value !== "group") : views;
  const view = direct && linked === "group" ? "overview" : linked;
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
          {tabs.map(({ value, label }) => (
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
        <div className="flex justify-self-end">
          {/* Phones keep theirs in the panel switcher above. */}
          <SettingsButton className="hidden md:inline-flex" />
          <FullWindowButton view={view} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tabs.map(({ value }) => (
          <TabsContent key={value} value={value}>
            {value === "group" ? <GroupInfo /> : null}
            {value === "overview" ? <Overview /> : null}
            {value === "tasks" ? <Tasks /> : null}
            {value === "routines" ? <Routines /> : null}
            {value === "inbox" ? <Inbox /> : null}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
