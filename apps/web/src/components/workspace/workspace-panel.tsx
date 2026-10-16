import type { WorkspaceView } from "./types";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { SidebarSimpleIcon } from "@phosphor-icons/react/SidebarSimple";
import { XIcon } from "@phosphor-icons/react/X";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GroupArtifacts, GroupMembers } from "./groups";
import { Inbox } from "./inbox";
import { Overview } from "./overview";
import { RefreshButton } from "./refresh-button";
import { useRoutineNav } from "./routine-nav";
import { Routines } from "./routines";
import { SettingsButton } from "./settings-dialog";
import { useTaskNav } from "./task-nav";
import { Tasks } from "./tasks";
import { useAttention } from "./use-attention";
import { hasPage, sectionPaths, usePanelViews } from "./workspace-search";

/** Opens the full window at the side panel's current data context. */
function FullWindowButton({ view }: { view: WorkspaceView }) {
  const { t: translateText } = useTranslation([
    "navigation",
    "common",
  ] as const);
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
        aria-label={translateText("actions.openFullWindow")}
        title={translateText("actions.openFullWindow")}
      >
        <ArrowsOutIcon aria-hidden="true" />
      </Link>
    </Button>
  );
}

/**
 * The home page's side panel. A group chat's holds the group (成员 and
 * Artifacts); a direct chat's the workspace. A view the panel has no tab for,
 * such as an old link's, opens its first tab.
 */
export function WorkspacePanel({
  view: linked,
  onViewChange,
  className,
  onClose,
  onCollapse,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  className?: string;
  /** Closes the drawer it is between md and lg. */
  onClose?: () => void;
  /** Folds it away from lg up. */
  onCollapse?: () => void;
}) {
  const { t: translateText } = useTranslation([
    "navigation",
    "common",
  ] as const);
  const pending = useAttention().total;
  const tabs = usePanelViews();
  const view = tabs.some((tab) => tab.value === linked)
    ? linked
    : tabs[0].value;
  return (
    <Tabs
      id="workspace-panel"
      value={view}
      onValueChange={(value) => onViewChange(value as WorkspaceView)}
      className={cn(
        "@container/panel relative z-10 min-h-0 min-w-0 gap-0 overflow-hidden border border-border/70 bg-background shadow-[0_2px_4px_-2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.12)] dark:shadow-[0_2px_4px_-2px_rgb(0_0_0/0.2),0_12px_32px_-8px_rgb(0_0_0/0.4)]",
        className,
      )}
    >
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-3 pt-3">
        <div className="flex justify-self-start">
          {onCollapse ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={translateText("actions.collapseWorkspace")}
              title={translateText("common:actions.collapse")}
              className="hidden lg:inline-flex"
              onClick={onCollapse}
            >
              <SidebarSimpleIcon aria-hidden="true" className="-scale-x-100" />
            </Button>
          ) : null}
          {view === "tasks" || view === "routines" ? (
            <RefreshButton resource={view} />
          ) : null}
        </div>
        <TabsList
          variant="default"
          aria-label={translateText("accessibility.workspaceTabs")}
          className="gap-1"
        >
          {tabs.map(({ value, icon: Icon, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              title={label}
              className="group/tab px-2 text-xs sm:px-3"
            >
              <Icon aria-hidden="true" />
              {/* A narrow panel keeps only the open tab's name. */}
              <span className="@max-[30rem]/panel:group-data-[state=inactive]/tab:sr-only">
                {label}
              </span>
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
          {onClose ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={translateText("actions.closeWorkspace")}
              title={translateText("common:actions.close")}
              className="hidden md:max-lg:inline-flex"
              onClick={onClose}
            >
              <XIcon aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tabs.map(({ value }) => (
          <TabsContent key={value} value={value}>
            {value === "members" ? <GroupMembers /> : null}
            {value === "artifacts" ? <GroupArtifacts /> : null}
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
