import type { WorkspaceView } from "./types";
import { XIcon } from "@phosphor-icons/react/X";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useGroupArtifacts } from "./artifact-filter";
import { GroupArtifacts } from "./artifact-list";
import { GroupPanel } from "./group-panel";
import { Inbox } from "./inbox";
import { Tasks } from "./tasks";
import { useAttention } from "./use-attention";
import { useGroups } from "./use-groups";
import { usePanelViews } from "./workspace-search";

/**
 * The home page's side panel. A group chat's holds the group (members and
 * Artifacts); a direct chat's the workspace. A view the panel has no tab for,
 * such as an old link's, opens its first tab.
 */
export function WorkspacePanel({
  view: linked,
  onViewChange,
  className,
  style,
  onClose,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  className?: string;
  /** The width the gutter settled on, as a variable the panel's own classes apply: the phone
   * and the drawer size themselves, only the widest layout reads it. */
  style?: React.CSSProperties;
  /** Closes the drawer it is between md and lg. */
  onClose?: () => void;
}) {
  const { t: translateText } = useTranslation([
    "navigation",
    "common",
  ] as const);
  const pending = useAttention().total;
  const { current: group } = useGroups();
  const artifactCount = useGroupArtifacts(group?.id).artifacts.length;
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
      {/* The band is the window's drag strip on every column, this one included: the tabs and the
          close button keep their own clicks through the `no-drag` list in `styles.css`, and the
          strip around them is one more place a person can grab the window. */}
      <div className="band grid grid-cols-[1fr_auto_1fr] gap-2 px-3">
        <div aria-hidden="true" />
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
              {value === "artifacts" && artifactCount ? (
                <span className="tabular-nums">{artifactCount}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex justify-self-end">
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
      {/* The context tab's sections draw their own edge-to-edge rules and pad themselves; the
          other tabs (and the task detail's sticky header, which bleeds back over it) assume p-3.
          The artifacts tab lays itself out in three: its search on top and its pages at the
          bottom stay put, and only the list between them scrolls. */}
      <div
        className={cn(
          "min-h-0 flex-1",
          view === "artifacts"
            ? "flex flex-col overflow-hidden"
            : "overflow-y-auto",
          view === "context" || view === "artifacts" ? "p-0" : "p-3",
        )}
      >
        {tabs.map(({ value }) => (
          <TabsContent
            key={value}
            value={value}
            className={cn(
              "mt-0",
              value === "artifacts" && "flex min-h-0 flex-col",
            )}
          >
            {/* A group's panel is one column of blocks, not a tab per half of it. */}
            {value === "context" ? <GroupPanel group={group} /> : null}
            {value === "artifacts" ? <GroupArtifacts /> : null}
            {value === "tasks" ? <Tasks /> : null}
            {value === "inbox" ? <Inbox /> : null}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
