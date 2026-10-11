import type { GitHubStatus, Installation } from "@/queries/forge";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useId, useState } from "react";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  authorizationCallbackPath,
  useAuthorizeGitHub,
  useCreateGitHubApp,
  useDisconnectGitHub,
  useGitHubStatus,
  useRefreshGitHub,
  useSetGitHubOAuthClient,
  useUnauthorizeGitHub,
} from "@/queries/forge";
import { Stepper } from "./stepper";

const steps = ["了解", "创建 App", "安装到仓库", "完成"] as const;
type Step = 0 | 1 | 2 | 3;

/** Where the setup stands on the server; steps before it are done. */
function serverStep(status: GitHubStatus | undefined): Step {
  if (!status || status.state === "not_connected") return 0;
  return status.state === "ready" ? 3 : 2;
}

const features = [
  [GitBranchIcon, "在你授权的仓库里 clone、提交和推送分支"],
  [GitPullRequestIcon, "用 gh 处理 PR、Issue、Release 和 CI"],
] as const;

function Intro() {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        AXP 会在你的 GitHub 上创建一个专属 App，智能体以它的身份工作：
      </p>
      <ul className="space-y-2">
        {features.map(([Icon, text]) => (
          <li key={text} className="flex items-center gap-2.5 text-sm">
            <span className="flex size-7 shrink-0 items-center justify-center bg-muted">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateForm({
  error,
  onSubmit,
}: {
  error?: string;
  onSubmit: (input: { name: string; organization?: string }) => void;
}) {
  const [name, setName] = useState("");
  const [owner, setOwner] = useState<"user" | "organization">("user");
  const [organization, setOrganization] = useState("");
  const nameId = useId();
  const orgId = useId();
  return (
    <form
      id="github-create"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (owner === "organization" && !organization.trim()) return;
        onSubmit({
          // GitHub App names are unique across GitHub; the suggestion is
          // unlikely to be taken.
          name: name.trim() || `AXP ${crypto.randomUUID().slice(0, 4)}`,
          organization:
            owner === "organization" ? organization.trim() : undefined,
        });
      }}
    >
      {error ? <Alert>{error}</Alert> : null}
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">创建在</legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["user", "我的个人账号", "仓库在你自己名下"],
              ["organization", "一个组织", "需要你是组织的 owner"],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 border p-3 transition-colors hover:bg-muted/50 has-focus-visible:ring-1 has-focus-visible:ring-ring",
                owner === value && "border-foreground bg-muted/50",
              )}
            >
              <input
                type="radio"
                name="github-owner"
                value={value}
                checked={owner === value}
                onChange={() => setOwner(value)}
                className="sr-only"
              />
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </label>
          ))}
        </div>
        {owner === "organization" ? (
          <div className="space-y-1.5 pt-1">
            <label htmlFor={orgId} className="text-xs font-medium">
              组织名称
            </label>
            <Input
              id={orgId}
              value={organization}
              placeholder="例如 acme"
              maxLength={39}
              required
              pattern={String.raw`.*\S.*`}
              spellCheck={false}
              autoFocus
              onInvalid={(e) =>
                e.currentTarget.setCustomValidity("请输入组织名称")
              }
              onChange={(e) => {
                e.currentTarget.setCustomValidity("");
                setOrganization(e.target.value);
              }}
            />
          </div>
        ) : null}
      </fieldset>
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          App 名称
          <span className="ml-1.5 font-normal text-muted-foreground">可选</span>
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={34}
          placeholder="留空则自动生成，例如 AXP 3f2a"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">在 GitHub 上不能重名</p>
      </div>
      <p className="text-xs text-muted-foreground">
        在 GitHub 上点击「Create GitHub App」后会自动回到这里。
      </p>
    </form>
  );
}

function Install({ status }: { status: GitHubStatus }) {
  const app = status.app!;
  return (
    <div className="space-y-4">
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
        已创建，接下来把它安装到你的仓库：
      </p>
      <ol className="space-y-2">
        {[
          "选择要安装到的账号或组织",
          "勾选智能体可以访问的仓库，或选择「All repositories」",
          "点击「Install」；GitHub 接着请你授权时确认，智能体就能以你的名义使用 GitHub",
        ].map((text, index) => (
          <li key={text} className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center border text-xs tabular-nums"
            >
              {index + 1}
            </span>
            {text}
          </li>
        ))}
      </ol>
    </div>
  );
}

function repositoriesText(installation: Installation) {
  if (installation.repository_selection === "all") return "全部仓库";
  const shown = installation.repositories
    .slice(0, 3)
    .map((name) => name.split("/")[1]);
  if (!shown.length) return "还没有选择仓库";
  const more = installation.total_repositories - shown.length;
  return more > 0
    ? `${shown.join("、")} 等 ${installation.total_repositories} 个仓库`
    : shown.join("、");
}

function Done({ status }: { status: GitHubStatus }) {
  const app = status.app!;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <CheckCircleIcon
          aria-hidden="true"
          weight="fill"
          className="size-6 shrink-0"
        />
        <div>
          <p className="text-sm font-medium">已连接</p>
          <p className="text-xs text-muted-foreground">
            {status.user
              ? `智能体以 ${status.user.login} 的名义使用 GitHub，commit 作者是 `
              : "智能体以 "}
            <a
              href={app.html_url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              {app.slug}[bot]
            </a>
            {status.user ? "。" : " 的身份使用 GitHub。"}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <ul aria-label="已安装的账号" className="divide-y border">
          {status.installations.map((installation) => (
            <li
              key={installation.id}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {installation.account}
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                    {installation.account_type === "Organization"
                      ? "组织"
                      : "个人"}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {repositoriesText(installation)}
                </p>
              </div>
              {installation.manage_url ? (
                <Button asChild variant="ghost" size="sm">
                  <a
                    href={installation.manage_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    管理
                    <ArrowSquareOutIcon aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <a href={app.install_url}>安装到其他账号或组织</a>
        </Button>
      </div>
      <Authorization status={status} />
    </div>
  );
}

/**
 * The user authorizing the App to act on their behalf: agents then use
 * GitHub as the user, with the App's badge, and can do what GitHub allows
 * only a user, such as creating a repository in their account. An App
 * created before AXP kept its client secret needs the secret first.
 */
function Authorization({ status }: { status: GitHubStatus }) {
  const authorize = useAuthorizeGitHub();
  const unauthorize = useUnauthorizeGitHub();
  const onError = (error: Error) => toast.error(error.message);
  if (status.user) {
    return (
      <section className="flex items-center gap-3 border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            智能体的身份：{status.user.login}
          </p>
          <p className="text-xs text-muted-foreground">
            gh、推送、PR 和合并都以你的名义，GitHub 显示为你本人并带 App
            的标识。取消授权后一小时内回到 App 的身份。
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={unauthorize.isPending}
          onClick={() => unauthorize.mutate(undefined, { onError })}
        >
          取消授权
        </Button>
      </section>
    );
  }
  return (
    <section className="space-y-3 border px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">以你的名义使用 GitHub</p>
        <p className="text-xs text-muted-foreground">
          授权后，智能体以你的名义使用
          GitHub，也能在你的个人账号下创建仓库；不授权时是 App 的 bot，GitHub
          不允许它在个人账号下创建仓库。
        </p>
      </div>
      {status.oauth ? null : (
        <OAuthClientForm settingsURL={status.app!.settings_url} />
      )}
      <Button
        size="sm"
        disabled={!status.oauth || authorize.isPending}
        onClick={() => authorize.mutate(undefined, { onError })}
      >
        <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
        {authorize.isPending ? "正在打开 GitHub…" : "前往 GitHub 授权"}
      </Button>
    </section>
  );
}

function OAuthClientForm({ settingsURL }: { settingsURL: string }) {
  const save = useSetGitHubOAuthClient();
  const [clientID, setClientID] = useState("");
  const [secret, setSecret] = useState("");
  const idId = useId();
  const secretId = useId();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(
          { client_id: clientID.trim(), client_secret: secret.trim() },
          { onError: (error) => toast.error(error.message) },
        );
      }}
    >
      <p className="text-xs text-muted-foreground">
        这个 App 创建得早，AXP 没有保存它的 client secret。请在{" "}
        <a
          href={settingsURL}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          App 设置
        </a>{" "}
        里把 Callback URL 设为{" "}
        <code className="break-all text-foreground">
          {window.location.origin + authorizationCallbackPath}
        </code>
        ，生成一个新的 client secret，然后填在这里：
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={idId} className="text-xs font-medium">
            Client ID
          </label>
          <Input
            id={idId}
            value={clientID}
            required
            spellCheck={false}
            onChange={(e) => setClientID(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={secretId} className="text-xs font-medium">
            Client secret
          </label>
          <Input
            id={secretId}
            type="password"
            value={secret}
            required
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
      </div>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={save.isPending}
      >
        保存
      </Button>
    </form>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <WarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {children}
    </p>
  );
}

function Disconnect({ status }: { status: GitHubStatus }) {
  const disconnect = useDisconnectGitHub();
  const app = status.app!;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" className="text-muted-foreground sm:mr-auto">
          断开连接
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>断开 GitHub？</AlertDialogTitle>
          <AlertDialogDescription>
            AXP 会删除保存的 App 凭据，智能体将无法再访问私有仓库，也不能推送和
            打开 PR。GitHub 上的 App {app.name} 不会被删除。
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

/**
 * Connecting GitHub, one step at a time: what it does, creating the App,
 * installing it, done. The server's state decides how far along it is;
 * GitHub's redirects bring the browser back with the dialog open.
 */
export function GitHubWizard({
  open,
  onOpenChange,
  returnError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnError?: string;
}) {
  const {
    data: status,
    error,
    isPending,
    refetch,
    isFetching,
  } = useGitHubStatus();
  const refresh = useRefreshGitHub();
  const create = useCreateGitHubApp();
  const reached = serverStep(status);
  // Before the App exists the user moves between the first two steps; a
  // failed creation returns to the second (the parent remounts on errors).
  const [local, setLocal] = useState<0 | 1>(returnError ? 1 : 0);
  const step: Step = reached === 0 ? local : reached;

  const body = error ? (
    <LoadError
      what="GitHub 的连接状态"
      error={error}
      onRetry={() => void refetch()}
    />
  ) : isPending ? (
    <Loading layout="lines" />
  ) : status.state === "error" ? (
    <Alert>{status.error?.message ?? "GitHub 连接出错。"}</Alert>
  ) : step === 0 ? (
    <Intro />
  ) : step === 1 ? (
    <CreateForm
      error={returnError}
      onSubmit={(input) =>
        create.mutate(input, {
          onError: (failure) => toast.error(failure.message),
        })
      }
    />
  ) : step === 2 ? (
    <Install status={status} />
  ) : (
    <Done status={status} />
  );

  let footer: React.ReactNode = null;
  if (status?.state === "error") {
    footer = (
      <>
        <Disconnect status={status} />
        <Button onClick={() => void refetch()} disabled={isFetching}>
          重试
        </Button>
      </>
    );
  } else if (status && step === 0) {
    footer = <Button onClick={() => setLocal(1)}>开始连接</Button>;
  } else if (status && step === 1) {
    footer = (
      <>
        <Button
          variant="ghost"
          className="sm:mr-auto"
          onClick={() => setLocal(0)}
        >
          上一步
        </Button>
        <Button type="submit" form="github-create" disabled={create.isPending}>
          <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
          {create.isPending ? "正在打开 GitHub…" : "前往 GitHub 创建"}
        </Button>
      </>
    );
  } else if (status && step === 2) {
    footer = (
      <>
        <Disconnect status={status} />
        <Button
          variant="outline"
          disabled={isFetching}
          onClick={() => void refresh()}
        >
          我已安装
        </Button>
        <Button asChild>
          <a href={status.app!.install_url}>
            <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
            前往 GitHub 安装
          </a>
        </Button>
      </>
    );
  } else if (status && step === 3) {
    footer = (
      <>
        <Disconnect status={status} />
        <Button onClick={() => onOpenChange(false)}>完成</Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-2">
          <GithubLogoIcon aria-hidden="true" className="size-5" />
          <DialogTitle className="text-sm">连接 GitHub</DialogTitle>
        </DialogHeader>
        <Stepper
          steps={steps}
          step={step}
          label="连接步骤"
          complete={step === 3}
        />
        <div className="min-h-64">{body}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
