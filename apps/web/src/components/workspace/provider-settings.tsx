import type { ReactNode } from "react";
import type { Connection, Connector, Usage } from "@/queries/llm";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
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
} from "@/components/ui/alert-dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  GROK_CONNECTOR,
  NEEDS_ACTION,
  USABLE,
  useCancelLogin,
  useConnections,
  useConnectors,
  useDeleteConnection,
  useLoginStatus,
  useModels,
  useRefreshLlmStatus,
  useSetConnectionEnabled,
  useStartLogin,
  useUsage,
} from "@/queries/llm";
import { connectionStateLabels, untilText } from "./connection-state";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

const windowLabels: Record<string, string> = {
  "5h": "5 小时",
  weekly: "每周",
  monthly: "每月",
};

/** Remaining share of each subscription window, as the provider reports it. */
function UsageWindows({ usage }: { usage: Usage }) {
  if (usage.error)
    return <p className="text-xs text-muted-foreground">{usage.error}</p>;
  if (!usage.windows.length) return null;
  return (
    <dl className="grid grid-cols-[2.5rem_minmax(0,1fr)_11.5rem] items-center gap-x-3 gap-y-1.5 text-xs">
      {usage.windows.map((window) => {
        const left = Math.round(100 - window.used);
        const label = windowLabels[window.kind] ?? window.kind;
        return (
          <div key={window.kind} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              role="meter"
              aria-label={`${label}剩余额度`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={left}
              className="h-1.5 bg-muted"
            >
              <div
                className={cn(
                  "h-full",
                  left <= 10 ? "bg-destructive" : "bg-foreground/70",
                )}
                style={{ width: `${left}%` }}
              />
            </dd>
            <dd className="text-right tabular-nums text-muted-foreground">
              <span className="text-foreground">剩余 {left}%</span>
              {window.resets_at
                ? ` · ${untilText(window.resets_at, "重置") || "即将重置"}`
                : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ConnectionState({ connection }: { connection: Connection }) {
  const warn = NEEDS_ACTION.has(connection.state);
  const degraded = connection.state === "degraded";
  const until =
    connection.state === "rate_limited" || degraded
      ? untilText(connection.retry_at)
      : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        warn
          ? "text-destructive"
          : degraded
            ? "text-amber-600 dark:text-amber-500"
            : "text-muted-foreground",
      )}
    >
      {warn || degraded ? (
        <WarningIcon aria-hidden="true" className="size-3.5" />
      ) : null}
      {connectionStateLabels[connection.state]}
      {until ? ` · ${until}` : null}
    </span>
  );
}

/** Device-code login: show the code, open the provider page, wait. */
function LoginDialog({
  connector,
  open,
  onOpenChange,
}: {
  connector: Connector;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const status = useLoginStatus(start.data?.id);
  const login = status.data ?? start.data;
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef(false);

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      start.mutate(connector.id);
    }
  }, [open, connector.id, start]);
  useEffect(() => {
    if (!open || login?.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, login?.status]);
  useEffect(() => {
    if (login?.status === "succeeded") {
      toast.success(`已绑定 ${connector.display_name} 账号`);
      onOpenChange(false);
    }
  }, [login?.status, connector.display_name, onOpenChange]);

  const close = (next: boolean) => {
    if (!next && login?.status === "pending") cancel.mutate(login.id);
    onOpenChange(next);
  };
  const retry = () => {
    start.reset();
    start.mutate(connector.id);
  };
  const seconds = login
    ? Math.max(
        0,
        Math.round((new Date(login.expires_at).getTime() - now) / 1000),
      )
    : 0;
  const error =
    start.error?.message ??
    status.error?.message ??
    (login && login.status !== "pending" && login.status !== "succeeded"
      ? (login.error ?? "登录失败，请重试。")
      : undefined);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>绑定 {connector.display_name} 账号</DialogTitle>
          <DialogDescription>
            打开授权页面，登录后输入下面的验证码。
          </DialogDescription>
        </DialogHeader>
        {login?.user_code && !error ? (
          <div className="flex items-center justify-between gap-2 bg-muted px-3 py-2">
            <span
              className="font-mono text-2xl font-semibold tracking-widest"
              aria-label={`验证码 ${login.user_code}`}
            >
              {login.user_code}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="复制验证码"
              onClick={() =>
                navigator.clipboard
                  .writeText(login.user_code ?? "")
                  .then(() => toast.success("已复制"))
              }
            >
              <CopyIcon aria-hidden="true" />
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {login
              ? `等待授权… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} 后过期`
              : "正在获取验证码…"}
          </p>
        )}
        {connector.hint ? (
          <p className="text-xs text-muted-foreground">{connector.hint}</p>
        ) : null}
        <DialogFooter>
          {error ? (
            <Button onClick={retry} disabled={start.isPending}>
              重试
            </Button>
          ) : (
            <Button asChild disabled={!login?.url}>
              <a href={login?.url} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                打开授权页面
              </a>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionRow({
  connection,
  connector,
  usage,
  onRelogin,
  affectedAgents,
}: {
  connection: Connection;
  connector: Connector;
  usage: Usage | undefined;
  onRelogin: () => void;
  affectedAgents: string[];
}) {
  const setEnabled = useSetConnectionEnabled();
  const remove = useDeleteConnection();
  const [confirming, setConfirming] = useState(false);
  const onError = (error: Error) => toast.error(error.message);
  const disabled = connection.state === "disabled";
  const plan = usage?.plan || connection.plan;

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {connection.label}
          </span>
          {plan ? (
            <Badge variant="secondary" className="capitalize">
              {plan}
            </Badge>
          ) : null}
          <ConnectionState connection={connection} />
        </span>
        {NEEDS_ACTION.has(connection.state) ? (
          <Button size="sm" variant="outline" onClick={onRelogin}>
            重新登录
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`${connection.label} 的操作`}
            >
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onSelect={onRelogin}>重新登录</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                setEnabled.mutate(
                  { id: connection.id, enabled: disabled },
                  { onError },
                )
              }
            >
              {disabled ? "启用" : "停用"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              移除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {connection.error && connection.state !== "disabled" ? (
        <p className="text-xs text-muted-foreground">
          {connection.error.message}
        </p>
      ) : null}
      {connection.check_error?.code === "CHECK_FAILED" ? (
        <p className="text-xs text-muted-foreground">
          {connection.check_error.message}
        </p>
      ) : null}
      {usage && !disabled ? <UsageWindows usage={usage} /> : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>移除 {connection.label}？</AlertDialogTitle>
            <AlertDialogDescription>
              {affectedAgents.length
                ? `${affectedAgents.join("、")} 使用的 ${connector.display_name} 模型将不可用，直到重新绑定账号。`
                : `该 ${connector.display_name} 账号的登录信息会被删除。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(connection.id, {
                  onSuccess: () => toast.success(`已移除 ${connection.label}`),
                  onError,
                })
              }
            >
              移除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function timeText(ms: number) {
  return new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });
}

/**
 * Checks every account against its provider now. A failed check keeps the
 * status shown; the outcome stays next to the button until the next one.
 */
export function RefreshStatus({ className }: { className?: string }) {
  const refresh = useRefreshLlmStatus();
  // Another settings page may be checking: one round at a time.
  const busy = useIsMutating({ mutationKey: ["llm", "refresh"] }) > 0;
  const result = refresh.data;
  const failedChecks = result?.connections.filter(
    (connection) => connection.check_error,
  ).length;
  const outcome = refresh.isError
    ? `刷新失败：${refresh.error.message}仍显示之前的状态。`
    : result
      ? [
          `已于 ${timeText(refresh.submittedAt)} 重新检查`,
          failedChecks ? `${failedChecks} 个账号未能检查` : "账号均可连接",
        ].join("，")
      : "";
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col-reverse items-end gap-1 sm:flex-row sm:items-center sm:gap-2",
        className,
      )}
    >
      <p
        role="status"
        className={cn(
          "min-w-0 text-right text-xs empty:hidden",
          refresh.isError || failedChecks
            ? "text-destructive"
            : "text-muted-foreground",
        )}
      >
        {busy ? "正在检查…" : outcome}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-busy={busy}
        disabled={busy}
        onClick={() => refresh.mutate()}
        className="shrink-0"
      >
        <ArrowClockwiseIcon
          aria-hidden="true"
          data-icon="inline-start"
          className={busy ? "motion-safe:animate-spin" : undefined}
        />
        {busy ? "检查中" : "刷新状态"}
      </Button>
    </div>
  );
}

export function ConnectorSection({
  connector,
  connections,
  usage,
  hideHeading,
  description,
}: {
  connector: Connector;
  connections: Connection[];
  usage: Usage[] | undefined;
  /** Where a surrounding title already names the provider. */
  hideHeading?: boolean;
  /** A line under the heading, about what else the accounts serve. */
  description?: ReactNode;
}) {
  const [login, setLogin] = useState(0);
  const { agents } = useAgents();
  const { data: models } = useModels();
  const headingId = `connector-${connector.id}`;
  // Removing the last usable account takes this connector's models away.
  const affectedBy = (connection: Connection) => {
    const others = connections.some(
      (other) => other.id !== connection.id && USABLE.has(other.state),
    );
    if (others) return [];
    const ids = new Set(
      (models ?? [])
        .filter((model) => model.connector === connector.id)
        .map((model) => model.id),
    );
    return agents
      .filter((agent) => agent.model && ids.has(agent.model))
      .map((agent) => `「${agent.name}」`);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <div
        className={cn(
          "flex items-center justify-between gap-2",
          hideHeading && "justify-end",
        )}
      >
        <h3
          id={headingId}
          className={cn("text-sm font-medium", hideHeading && "sr-only")}
        >
          {connector.display_name}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setLogin((n) => n + 1)}
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          绑定账号
        </Button>
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      {connections.length ? (
        <ul
          aria-label={`${connector.display_name} 账号`}
          className="divide-y border"
        >
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              connector={connector}
              usage={usage?.find((item) => item.id === connection.id)}
              onRelogin={() => setLogin((n) => n + 1)}
              affectedAgents={affectedBy(connection)}
            />
          ))}
        </ul>
      ) : (
        <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          尚未绑定账号
        </p>
      )}
      {login ? (
        // Keyed so every open starts a fresh login.
        <LoginDialog
          key={login}
          connector={connector}
          open
          onOpenChange={(open) => !open && setLogin(0)}
        />
      ) : null}
    </section>
  );
}

/**
 * Settings → 模型服务: accounts per provider and their state. Grok's account
 * also powers the grok plugin, whose card under 连接 shows the same accounts.
 */
export function ProviderSettings() {
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const connectors = useConnectors();
  const connections = useConnections();
  const { data: usage } = useUsage();

  if (connectors.error)
    return (
      <LoadError
        what="模型服务"
        error={connectors.error}
        onRetry={() => void connectors.refetch()}
      />
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">模型服务</h2>
        <RefreshStatus />
      </div>
      {connections.error ? (
        <p role="alert" className="text-xs text-destructive">
          无法加载账号：{connections.error.message}
        </p>
      ) : null}
      {connectors.isPending ? <Loading rows={2} /> : null}
      {(connectors.data ?? []).map((connector) => (
        <ConnectorSection
          key={connector.id}
          connector={connector}
          connections={(connections.data ?? []).filter(
            (connection) => connection.connector === connector.id,
          )}
          usage={usage}
          description={
            connector.id === GROK_CONNECTOR ? (
              <>
                同一账号也供 grok 插件生成图片、视频和搜索，见
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-1"
                  onClick={() =>
                    setSettings({ open: true, section: "connections" })
                  }
                >
                  连接
                </Button>
              </>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}
