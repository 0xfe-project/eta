import type { GitHubStatus, Installation } from "@/queries/forge";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { BrainIcon } from "@phosphor-icons/react/Brain";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  useCreateGitHubApp,
  useDisconnectGitHub,
  useGitHubStatus,
  useRefreshGitHub,
} from "@/queries/forge";
import { useConnections } from "@/queries/llm";
import { useWorkspaceStore } from "./workspace-store";

// Query parameters GitHub and the forge service send the browser back with.
const RETURN_PARAMS = [
  "github",
  "github_error",
  "installation_id",
  "setup_action",
];

/**
 * Coming back from GitHub (App created, installed or failed): say what
 * happened, show this view, and drop the parameters from the address.
 */
function useReturnFromGitHub(onError: (message: string) => void) {
  const refresh = useRefreshGitHub();
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (!RETURN_PARAMS.some((name) => params.has(name))) return;
    const error = params.get("github_error");
    if (error) onError(error);
    else if (params.get("github") === "created")
      toast.success("GitHub App 已创建，接下来把它安装到仓库");
    else if (params.get("setup_action"))
      toast.success("已在 GitHub 上更新 App 的安装");
    for (const name of RETURN_PARAMS) params.delete(name);
    window.history.replaceState(window.history.state, "", url);
    setMobilePanel("workspace");
    void refresh();
  }, [onError, refresh, setMobilePanel]);
}

const steps = ["创建 App", "安装到仓库", "完成"] as const;

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="连接步骤" className="flex items-center gap-2 text-xs">
      {steps.map((label, index) => {
        const done = index < current || current === steps.length - 1;
        return (
          <li
            key={label}
            aria-current={index === current ? "step" : undefined}
            className={cn(
              "flex items-center gap-1.5",
              index === current
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 items-center justify-center border tabular-nums",
                done && "border-primary bg-primary text-primary-foreground",
                index === current && !done && "border-foreground",
              )}
            >
              {done ? <CheckIcon className="size-3" /> : index + 1}
            </span>
            {label}
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="ml-0.5 h-px w-4 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Step 1: name the App and where it lives, then create it on GitHub. */
function CreateApp() {
  const create = useCreateGitHubApp();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState<"user" | "organization">("user");
  const [organization, setOrganization] = useState("");
  const nameId = useId();
  const orgId = useId();
  const valid = owner === "user" || organization.trim().length > 0;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        create.mutate(
          {
            // GitHub App names are unique across GitHub; the suggestion is
            // unlikely to be taken.
            name: name.trim() || `AXP ${crypto.randomUUID().slice(0, 4)}`,
            organization:
              owner === "organization" ? organization.trim() : undefined,
          },
          { onError: (error) => toast.error(error.message) },
        );
      }}
    >
      <p className="text-sm text-muted-foreground">
        AXP 会在你的 GitHub 上创建一个专属的 GitHub App。智能体以它的身份
        clone、推送分支和打开 PR，PR 上会显示由这个 App 打开。
      </p>
      <div className="grid gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          App 名称
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={34}
          placeholder="留空则自动生成，例如 AXP 3f2a"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          在整个 GitHub 上不能重名，PR 的作者会显示为它的 bot 账号。
        </p>
      </div>
      <fieldset className="grid gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">创建在</legend>
        {(
          [
            ["user", "我的个人账号"],
            ["organization", "一个组织"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="github-owner"
              value={value}
              checked={owner === value}
              onChange={() => setOwner(value)}
              className="accent-primary"
            />
            {label}
          </label>
        ))}
        {owner === "organization" ? (
          <div className="grid gap-1.5 pl-6">
            <label htmlFor={orgId} className="sr-only">
              组织名称
            </label>
            <Input
              id={orgId}
              value={organization}
              placeholder="组织的登录名，例如 acme"
              maxLength={39}
              spellCheck={false}
              onChange={(e) => setOrganization(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              需要你是这个组织的 owner。
            </p>
          </div>
        ) : null}
      </fieldset>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">App 会申请哪些权限</summary>
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
          <li>代码与 PR：读写（推送分支、打开 PR）</li>
          <li>Issue、Actions、检查与状态：只读</li>
          <li>不能修改 GitHub Actions 工作流，不接收 webhook</li>
          <li>只能访问你在下一步中授权的仓库</li>
        </ul>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!valid || create.isPending}>
          <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
          {create.isPending ? "正在前往 GitHub…" : "前往 GitHub 创建"}
        </Button>
        <p className="text-xs text-muted-foreground">
          在 GitHub 页面上点击「Create GitHub App」，完成后会自动回到这里。
        </p>
      </div>
    </form>
  );
}

/** Step 2: install the App for an account and choose its repositories. */
function InstallApp({ status }: { status: GitHubStatus }) {
  const refresh = useRefreshGitHub();
  const app = status.app!;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        App{" "}
        <a
          href={app.html_url}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          {app.name}
        </a>{" "}
        已创建。现在把它安装到你的账号或组织，并选择智能体可以访问的仓库。
      </p>
      <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
        <li>在 GitHub 上选择要安装到的账号或组织。</li>
        <li>
          选择「Only select repositories」并勾选仓库，或「All repositories」。
        </li>
        <li>点击「Install」，完成后会自动回到这里。</li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <a href={app.install_url}>
            <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
            前往 GitHub 安装
          </a>
        </Button>
        <Button variant="outline" onClick={() => void refresh()}>
          <ArrowClockwiseIcon aria-hidden="true" data-icon="inline-start" />
          我已安装，刷新
        </Button>
      </div>
    </div>
  );
}

function repositoriesText(installation: Installation) {
  if (installation.repository_selection === "all") return "全部仓库";
  const shown = installation.repositories
    .slice(0, 3)
    .map((name) => name.split("/")[1]);
  const more = installation.total_repositories - shown.length;
  if (!shown.length) return "还没有选择仓库";
  return more > 0
    ? `${shown.join("、")} 等 ${installation.total_repositories} 个仓库`
    : shown.join("、");
}

/** Step 3: what the agents can reach, and how to change it. */
function Connected({ status }: { status: GitHubStatus }) {
  const app = status.app!;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        智能体可以 clone 和推送这些仓库、用 gh 读取 PR 与 CI，并通过
        open_pull_request 以{" "}
        <span className="font-medium text-foreground">{app.slug}[bot]</span>{" "}
        的身份打开 PR。推送默认分支前会先请你确认。
      </p>
      <ul aria-label="已安装的账号" className="divide-y border">
        {status.installations.map((installation) => (
          <li
            key={installation.id}
            className="flex items-start gap-3 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {installation.account}
                <Badge variant="secondary">
                  {installation.account_type === "Organization"
                    ? "组织"
                    : "个人"}
                </Badge>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {repositoriesText(installation)}
              </p>
            </div>
            {installation.manage_url ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={installation.manage_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  管理仓库
                  <ArrowSquareOutIcon aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <Button asChild variant="ghost" size="sm" className="px-0">
        <a href={app.install_url}>安装到其他账号或组织</a>
      </Button>
    </div>
  );
}

function Disconnect({ status }: { status: GitHubStatus }) {
  const disconnect = useDisconnectGitHub();
  const app = status.app!;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          断开连接
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>断开 GitHub？</AlertDialogTitle>
          <AlertDialogDescription>
            AXP 会删除保存的 App 凭据，智能体将无法再访问 GitHub
            上的私有仓库，也不能推送和打开 PR。GitHub 上的 App {app.name}{" "}
            不会被删除，可以在它的 GitHub 设置中删除。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() =>
              disconnect.mutate(undefined, {
                onSuccess: () =>
                  toast.success("已断开 GitHub", {
                    action: {
                      label: "去 GitHub 删除 App",
                      onClick: () => window.open(app.settings_url, "_blank"),
                    },
                  }),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            断开
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const stepOf: Record<GitHubStatus["state"], number> = {
  not_connected: 0,
  not_installed: 1,
  error: 1,
  ready: 2,
};

/** GitHub: a guided setup until the App is created and installed. */
function GitHubCapability() {
  const { data: status, error, isPending, refetch } = useGitHubStatus();
  const [returnError, setReturnError] = useState<string>();
  useReturnFromGitHub(setReturnError);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 border p-3 sm:p-4"
    >
      <div className="flex items-center gap-2">
        <GithubLogoIcon aria-hidden="true" className="size-5" />
        <h3 id={headingId} className="text-sm font-semibold">
          GitHub
        </h3>
        {status?.state === "ready" ? (
          <Badge variant="secondary">已连接</Badge>
        ) : status ? (
          <Badge variant="outline">需要配置</Badge>
        ) : null}
        <span className="ml-auto">
          {status?.app ? <Disconnect status={status} /> : null}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          无法读取 GitHub 的连接状态：{error.message}
        </p>
      ) : isPending ? (
        <p className="text-sm text-muted-foreground">正在加载…</p>
      ) : (
        <>
          <Steps current={stepOf[status.state]} />
          {returnError ? (
            <p
              role="alert"
              className="flex items-start gap-1.5 text-sm text-destructive"
            >
              <WarningIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0"
              />
              {returnError}
            </p>
          ) : null}
          {status.state === "error" ? (
            <div className="space-y-2">
              <p
                role="alert"
                className="flex items-start gap-1.5 text-sm text-destructive"
              >
                <WarningIcon
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0"
                />
                {status.error?.message ?? "GitHub 连接出错。"}
              </p>
              <Button variant="outline" onClick={() => void refetch()}>
                <ArrowClockwiseIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                重试
              </Button>
            </div>
          ) : status.state === "not_connected" ? (
            <CreateApp />
          ) : status.state === "not_installed" ? (
            <InstallApp status={status} />
          ) : (
            <Connected status={status} />
          )}
        </>
      )}
    </section>
  );
}

function OtherCapabilities() {
  const { data: connections } = useConnections();
  const grok = (connections ?? []).some(
    (connection) =>
      connection.connector === "xai" && connection.state === "active",
  );
  const items = [
    {
      icon: BrainIcon,
      name: "记忆",
      description: "跨对话记住事实与偏好，见“记忆”标签。",
      ready: true,
    },
    {
      icon: ListChecksIcon,
      name: "任务",
      description: "智能体在工作区里维护自己的任务清单。",
      ready: true,
    },
    {
      icon: ImageIcon,
      name: "Grok 图像与搜索",
      description: grok
        ? "生成图片和视频，搜索网页与 X。"
        : "需要在 设置 → 模型服务 中绑定 Grok 账号。",
      ready: grok,
    },
    {
      icon: ShieldCheckIcon,
      name: "操作确认",
      description: "推送默认分支等操作会先在对话中请你确认。",
      ready: true,
    },
  ];
  return (
    <ul aria-label="其他能力" className="divide-y border">
      {items.map(({ icon: Icon, name, description, ready }) => (
        <li key={name} className="flex items-start gap-3 px-3 py-2.5">
          <Icon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Badge variant={ready ? "secondary" : "outline"}>
            {ready ? "可用" : "需要配置"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/** What every agent can do, and the setup some of it needs. */
export function CapabilitiesView() {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">能力</h2>
      <GitHubCapability />
      <OtherCapabilities />
    </div>
  );
}
