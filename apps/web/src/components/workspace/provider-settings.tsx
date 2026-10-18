import type { ReactNode } from "react";
import type { Connection, Connector, Usage } from "@/queries/llm";

import type { ProviderView } from "@/queries/providers";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useIsMutating } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { formatLocale, listSeparator, translate } from "@/lib/i18n";
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
import { useProviders } from "@/queries/providers";
import { connectionStateLabels, untilText } from "./connection-state";
import { ProviderEditor } from "./provider-editor";
import { useAgents } from "./use-agents";
import { useWorkspaceStore } from "./workspace-store";

const windowLabels: Record<string, string> = {
  get "5h"() {
    return translate("common:time.windows.fiveHours");
  },
  get weekly() {
    return translate("common:time.windows.weekly");
  },
  get monthly() {
    return translate("common:time.windows.monthly");
  },
};

/** Remaining share of each subscription window, as the provider reports it. */
function UsageWindows({ usage }: { usage: Usage }) {
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
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
              aria-label={translateText("usage.remainingQuotaLabel", {
                label,
              })}
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
              <span className="text-foreground">
                {translateText("usage.remainingPercent", { percent: left })}
              </span>
              {window.resets_at
                ? translateText("common:format.inlineSeparator", {
                    label:
                      untilText(
                        window.resets_at,
                        translateText("usage.resets"),
                      ) || translateText("usage.resetsSoon"),
                  })
                : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ConnectionState({ connection }: { connection: Connection }) {
  useTranslation(["providers", "common", "connections"] as const);
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
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
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
      toast.success(
        translateText("login.linked", {
          providerName: connector.display_name,
        }),
      );
      onOpenChange(false);
    }
  }, [login?.status, connector.display_name, onOpenChange, translateText]);

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
      ? (login.error ?? translateText("login.failed"))
      : undefined);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translateText("login.title", {
              providerName: connector.display_name,
            })}
          </DialogTitle>
          <DialogDescription>
            {translateText("login.instructions")}
          </DialogDescription>
        </DialogHeader>
        {login?.user_code && !error ? (
          <div className="flex items-center justify-between gap-2 bg-muted px-3 py-2">
            <span
              className="font-mono text-2xl font-semibold tracking-widest"
              aria-label={translateText("login.codeLabel", {
                code: login.user_code,
              })}
            >
              {login.user_code}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("login.copyCode")}
              onClick={() =>
                navigator.clipboard
                  .writeText(login.user_code ?? "")
                  .then(() =>
                    toast.success(translateText("common:feedback.copied")),
                  )
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
              ? translateText("login.waitingWithExpiry", {
                  minutes: Math.floor(seconds / 60),
                  seconds: String(seconds % 60).padStart(2, "0"),
                })
              : translateText("login.loadingCode")}
          </p>
        )}
        {connector.hint ? (
          <p className="text-xs text-muted-foreground">{connector.hint}</p>
        ) : null}
        <DialogFooter>
          {error ? (
            <Button onClick={retry} disabled={start.isPending}>
              {translateText("common:actions.retry")}
            </Button>
          ) : (
            <Button asChild disabled={!login?.url}>
              <a href={login?.url} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon
                  aria-hidden="true"
                  data-icon="inline-start"
                />
                {translateText("login.openAuthorization")}
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
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
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
            {translateText("actions.signInAgain")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("common:accessibility.itemActions", {
                name: connection.label,
              })}
            >
              <DotsThreeIcon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onSelect={onRelogin}>
              {translateText("actions.signInAgain")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                setEnabled.mutate(
                  { id: connection.id, enabled: disabled },
                  { onError },
                )
              }
            >
              {disabled
                ? translateText("common:actions.enable")
                : translateText("common:actions.disable")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirming(true)}
            >
              {translateText("common:actions.remove")}
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
            <AlertDialogTitle>
              {translateText("remove.confirmTitle", {
                accountName: connection.label,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {affectedAgents.length
                ? translateText("remove.affectedAgents", {
                    agents: affectedAgents.join(listSeparator()),
                    providerName: connector.display_name,
                  })
                : translateText("remove.credentialsNotice", {
                    providerName: connector.display_name,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(connection.id, {
                  onSuccess: () =>
                    toast.success(
                      translateText("remove.success", {
                        accountName: connection.label,
                      }),
                    ),
                  onError,
                })
              }
            >
              {translateText("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function timeText(ms: number) {
  return new Date(ms).toLocaleTimeString(formatLocale(), { hour12: false });
}

/**
 * Checks every account against its provider now. A failed check keeps the
 * status shown; the outcome stays next to the button until the next one.
 */
export function RefreshStatus({ className }: { className?: string }) {
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
  const refresh = useRefreshLlmStatus();
  // Two sources, and both matter: this button's own request (`isPending`, which flips with the
  // render it belongs to), and any other settings page checking at the same time — one round at a
  // time, whichever one started it.
  const elsewhere = useIsMutating({ mutationKey: ["llm", "refresh"] }) > 0;
  const busy = refresh.isPending || elsewhere;
  const result = refresh.data;
  const failedChecks = result?.connections.filter(
    (connection) => connection.check_error,
  ).length;
  const outcome = refresh.isError
    ? translateText("refresh.failedWithPreviousStatus", {
        message: refresh.error.message,
      })
    : result
      ? [
          translateText("refresh.checkedAt", {
            time: timeText(refresh.submittedAt),
          }),
          failedChecks
            ? translateText("refresh.failedCount", {
                count: failedChecks,
              })
            : translateText("refresh.allReachable"),
        ].join(formatLocale() === "zh-CN" ? "，" : ", ")
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
        {busy ? translateText("refresh.checking") : outcome}
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
        {busy
          ? translateText("refresh.checkingLabel")
          : translateText("refresh.label")}
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
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
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
      .map((agent) =>
        translateText("common:format.quotedValue", { value: agent.name }),
      );
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
          {translateText("actions.linkAccount")}
        </Button>
      </div>
      {description ? (
        <p className="text-xs text-muted-foreground">{description}</p>
      ) : null}
      {connections.length ? (
        <ul
          aria-label={translateText("accounts.title", {
            providerName: connector.display_name,
          })}
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
          {translateText("accounts.empty")}
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
  const { t: translateText } = useTranslation([
    "providers",
    "common",
    "connections",
  ] as const);
  const setSettings = useWorkspaceStore((s) => s.setSettings);
  const connectors = useConnectors();
  const connections = useConnections();
  const { data: usage } = useUsage();

  if (connectors.error)
    return (
      <LoadError
        what={translateText("title")}
        error={connectors.error}
        onRetry={() => void connectors.refetch()}
      />
    );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        <RefreshStatus />
      </div>
      <ProviderRows />
      {connections.error ? (
        <p role="alert" className="text-xs text-destructive">
          {translateText("accounts.loadFailed", {
            message: connections.error.message,
          })}
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
                {translateText("grok.sharedAccountHelp")}
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-1"
                  onClick={() =>
                    setSettings({ open: true, section: "connections" })
                  }
                >
                  {translateText("connections:title")}
                </Button>
              </>
            ) : undefined
          }
        />
      ))}
    </div>
  );
}

/**
 * The providers as rows you can edit.
 *
 * The list above this (accounts per connector) answers "what can I sign into"; this answers "what
 * is configured", which is the half a person needs when a key rot or an endpoint moved. One row,
 * one editor: no nesting, because a provider is one object in the file and the form is that object.
 */
function ProviderRows() {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { data: providers } = useProviders();
  const [editing, setEditing] = useState<ProviderView | "new" | undefined>(
    undefined,
  );
  return (
    <section aria-labelledby="providers-configured" className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="providers-configured" className="text-sm font-medium">
          {translateText("editor.configured")}
        </h3>
        <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {translateText("editor.newTitle")}
        </Button>
      </div>
      {(providers ?? []).length === 0 ? (
        <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
          {translateText("editor.empty")}
        </p>
      ) : (
        <ul className="divide-y border">
          {(providers ?? []).map((provider) => (
            <li
              key={provider.id}
              className="flex min-w-0 items-center gap-2 px-3 py-1.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">
                  {provider.id}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {provider.kind} · {provider.baseUrl} ·{" "}
                  {translateText("editor.modelCount", {
                    count: provider.models.length,
                  })}
                  {provider.has_key
                    ? ""
                    : ` · ${translateText("editor.keyMissing")}`}
                </span>
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setEditing(provider)}
              >
                {translateText("common:actions.edit")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <ProviderEditor
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        provider={editing === "new" ? undefined : editing}
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
      />
    </section>
  );
}
