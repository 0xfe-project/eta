import type { WorkspaceView } from "./types";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { XIcon } from "@phosphor-icons/react/X";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { GroupPanel } from "./group-panel";
import { GroupArtifacts } from "./groups";
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
  style,
  onClose,
  onFocusMember,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  className?: string;
  /** The width the gutter settled on; the panel's own axis is vertical. */
  style?: React.CSSProperties;
  /** Closes the drawer it is between md and lg. */
  onClose?: () => void;
  /** Pressing a member narrows the chat to it. */
  onFocusMember?: (agentId: string) => void;
}) {
  const { t: translateText } = useTranslation([
    "navigation",
    "common",
  ] as const);
  const pending = useAttention().total;
  const { current: group } = useGroups();
  const tabs = usePanelViews();
  const view = tabs.some((tab) => tab.value === linked)
    ? linked
    : tabs[0].value;
  return (
    <Tabs
      id="workspace-panel"
      value={view}
      onValueChange={(value) => onViewChange(value as WorkspaceView)}
      style={style}
      className={cn(
        // The third column: flush with the window, its own field, its own band on top. No border
        // and no shadow — the gutter beside it is the separation, and a card here would make the
        // panel look like something floating over the chat rather than the window's right third.
        "@container/panel relative z-10 min-h-0 min-w-0 gap-0 overflow-hidden border-l bg-surface",
        className,
      )}
    >
      <div className="band grid grid-cols-[1fr_auto_1fr] gap-2 px-3">
        <div className="flex justify-self-start">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-0">
        {tabs.map(({ value }) => (
          <TabsContent key={value} value={value} className="mt-0">
            {/* A group's panel is one column of blocks, not a tab per half of it. */}
            {value === "members" ? (
              <GroupPanel group={group} onFocusMember={onFocusMember} />
            ) : null}
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
