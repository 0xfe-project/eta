import { Link } from "@tanstack/react-router";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { ArrowsInIcon } from "@phosphor-icons/react/ArrowsIn";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { views } from "./workspace-search";
import type { WorkspaceView } from "./types";
export function WorkspacePanel({
  view,
  onViewChange,
  fullWindow = false,
  className,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  fullWindow?: boolean;
  className?: string;
}) {
  return (
    <Tabs
      id="workspace-panel"
      value={view}
      onValueChange={(value) => onViewChange(value as WorkspaceView)}
      className={cn(
        "relative z-10 min-h-0 min-w-0 gap-0 overflow-hidden border border-border/70 bg-card shadow-[0_2px_4px_-2px_rgb(0_0_0/0.06),0_12px_32px_-8px_rgb(0_0_0/0.12)] dark:shadow-[0_2px_4px_-2px_rgb(0_0_0/0.2),0_12px_32px_-8px_rgb(0_0_0/0.4)]",
        fullWindow && "h-full border-0 shadow-none",
        className,
      )}
    >
      <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1 px-3 pt-3">
        <span aria-hidden="true" />
        <TabsList
          variant="default"
          aria-label="工作区标签"
          className="gap-1"
        >
          {views.map(({ value, label }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="px-2 text-xs sm:px-3"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <Button
          variant="ghost"
          size="icon-sm"
          className="justify-self-end"
          asChild
        >
          <Link
            to={fullWindow ? "/" : "/workspace"}
            search={{ view }}
            aria-label={fullWindow ? "返回双栏" : "在全窗口中打开"}
            title={fullWindow ? "返回双栏" : "在全窗口中打开"}
          >
            {fullWindow ? (
              <ArrowsInIcon aria-hidden="true" />
            ) : (
              <ArrowsOutIcon aria-hidden="true" />
            )}
          </Link>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {views.map(({ value }) => (
          <TabsContent key={value} value={value} />
        ))}
      </div>
    </Tabs>
  );
}
