import type { WorkspaceView } from "./types";
import type { GitHubStatus } from "@/queries/forge";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useGitHubStatus, useRefreshGitHub } from "@/queries/forge";
import { useConnections } from "@/queries/llm";
import { GitHubWizard } from "./github-wizard";
import { useWorkspaceView } from "./workspace-search";
import { useWorkspaceStore } from "./workspace-store";

interface Capability {
  id: string;
  icon: typeof BrainIcon;
  name: string;
  summary: string;
  /** Set when the capability needs the user to set something up. */
  todo?: string;
  action?: { label: string; run: () => void };
}

function CapabilityCard({
  capability,
  onOpen,
}: {
  capability: Capability;
  onOpen: () => void;
}) {
  const { icon: Icon, name, summary, todo } = capability;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-start gap-3 border bg-card p-3 text-left transition-colors duration-[60ms] ease-linear outline-none hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center bg-muted">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {todo ? <Badge variant="outline">{todo}</Badge> : null}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
          {summary}
        </span>
      </span>
      <CaretRightIcon
        aria-hidden="true"
        className="mt-2 size-3.5 shrink-0 text-muted-foreground transition-transform duration-[60ms] ease-linear group-hover:translate-x-0.5 motion-reduce:transition-none"
      />
    </button>
  );
}

function CapabilityDialog({
  capability,
  onClose,
}: {
  capability: Capability | undefined;
  onClose: () => void;
}) {
  if (!capability) return null;
  const { icon: Icon, name, summary, action } = capability;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="flex-row items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center bg-muted">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          <DialogTitle className="text-sm">{name}</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-sm">{summary}</DialogDescription>
        {action ? (
          <DialogFooter>
            <Button
              onClick={() => {
                onClose();
                action.run();
              }}
            >
              {action.label}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function githubCapability(status: GitHubStatus | undefined): Capability {
  const base = { id: "github", icon: GithubLogoIcon, name: "GitHub" };
  switch (status?.state) {
    case "ready":
      return {
        ...base,
        summary: `以 ${status.app?.slug}[bot] 的身份推送代码和打开 PR`,
      };
    case "not_installed":
      return { ...base, summary: "App 已创建，还需安装到仓库", todo: "待安装" };
    case "error":
      return {
        ...base,
        summary: status.error?.message ?? "连接出错",
        todo: "出错",
      };
    default:
      return {
        ...base,
        summary: "推送代码、以 App 身份打开 PR、读取 CI",
        todo: status ? "未连接" : undefined,
      };
  }
}

// Query parameters GitHub and the forge service send the browser back with.
const RETURN_PARAMS = [
  "github",
  "github_error",
  "installation_id",
  "setup_action",
];

/**
 * Coming back from GitHub (App created, installed or failed): reopen the
 * wizard where it now stands and drop the parameters from the address.
 */
function useReturnFromGitHub(onReturn: (error: string | undefined) => void) {
  const refresh = useRefreshGitHub();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (!RETURN_PARAMS.some((name) => params.has(name))) return;
    const error = params.get("github_error") ?? undefined;
    if (!error && params.get("github") === "created")
      toast.success("GitHub App 已创建");
    else if (!error && params.get("setup_action"))
      toast.success("已在 GitHub 上安装 App");
    for (const name of RETURN_PARAMS) params.delete(name);
    window.history.replaceState(window.history.state, "", url);
    setMobilePanel("workspace");
    onReturn(error);
    void refresh();
  }, [onReturn, refresh, setMobilePanel]);
}

/** What every agent can do; each card opens its details or setup. */
export function CapabilitiesView() {
  const { data: github } = useGitHubStatus();
  const { data: connections } = useConnections();
  const [, setView] = useWorkspaceView();
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const [open, setOpen] = useState<string>();
  const [returned, setReturned] = useState<{ error?: string }>();
  useReturnFromGitHub(
    useCallback((error: string | undefined) => {
      setReturned({ error });
      setOpen("github");
    }, []),
  );

  const grok = (connections ?? []).some(
    (connection) =>
      connection.connector === "xai" && connection.state === "active",
  );
  const show = (view: WorkspaceView) => () => void setView(view);
  const capabilities: Capability[] = [
    githubCapability(github),
    {
      id: "memory",
      icon: BrainIcon,
      name: "记忆",
      summary: "跨对话记住事实和偏好，每轮对话后自动整理",
      action: { label: "查看记忆", run: show("memory") },
    },
    {
      id: "tasks",
      icon: ListChecksIcon,
      name: "任务",
      summary: "在工作区里维护任务清单，跟踪进行中的工作",
      action: { label: "查看任务", run: show("tasks") },
    },
    {
      id: "grok",
      icon: ImageIcon,
      name: "Grok",
      summary: "生成图片和视频，搜索网页与 X",
      todo: connections && !grok ? "未绑定" : undefined,
      action: grok
        ? undefined
        : {
            label: "前往模型服务绑定 Grok",
            run: () => setSettings({ open: true, section: "providers" }),
          },
    },
    {
      id: "approval",
      icon: ShieldCheckIcon,
      name: "操作确认",
      summary: "推送默认分支等操作会先在对话中请你确认，允许只对那一次生效",
    },
  ];

  return (
    <>
      <h2 className="sr-only">能力</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {capabilities.map((capability) => (
          <CapabilityCard
            key={capability.id}
            capability={capability}
            onOpen={() => setOpen(capability.id)}
          />
        ))}
      </div>
      <GitHubWizard
        // A return from GitHub starts the wizard over where it now stands.
        key={returned ? `returned-${returned.error ?? ""}` : "wizard"}
        open={open === "github"}
        onOpenChange={(next) => setOpen(next ? "github" : undefined)}
        returnError={returned?.error}
      />
      <CapabilityDialog
        capability={capabilities.find(
          (capability) => capability.id === open && capability.id !== "github",
        )}
        onClose={() => setOpen(undefined)}
      />
    </>
  );
}
