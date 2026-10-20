import type {
  LlmConnection,
  LlmConnector,
  LlmQuota,
} from "@eta/client-contracts";
import { ArrowClockwiseIcon } from "@phosphor-icons/react/ArrowClockwise";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loading } from "@/components/states";
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
import { Input } from "@/components/ui/input";
import { listSeparator } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import { cn } from "@/lib/utils";
import {
  NEEDS_ACTION,
  USABLE,
  useCancelLogin,
  useLlm,
  useLoginPoll,
  useRefreshLlm,
  useRemoveConnection,
  useSetEnabled,
  useStartLogin,
  useSubmitApiKey,
} from "@/queries/llm";
import { wireErrorMessage } from "@/queries/wire";
import {
  connectionStateLabels,
  connectorHint,
  connectorKeyUrl,
  recoveryText,
  windowLabel,
} from "./llm-state";
import { useAgents } from "./use-agents";

/** Remaining share of each subscription window, as the provider reports it. */
function QuotaWindows({ quota }: { quota: LlmQuota }) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  if (quota.error)
    return (
      <p className="text-xs text-muted-foreground">
        {llmProblemText(quota.error)}
      </p>
    );
  if (quota.windows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[2.5rem_minmax(0,1fr)_11.5rem] items-center gap-x-3 gap-y-1.5 text-xs">
      {quota.windows.map((window) => {
        const left = Math.round(100 - window.used);
        const label = windowLabel(window.kind);
        return (
          <div key={window.kind} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd
              role="meter"
              aria-label={translateText("quota.remainingLabel", { label })}
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
                {translateText("quota.remainingPercent", { percent: left })}
              </span>
              {window.resetsAt
                ? translateText("common:format.inlineSeparator", {
                    label:
                      recoveryText(window.resetsAt, "reset") ||
                      translateText("quota.resetsSoon"),
                  })
                : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function ConnectionState({ connection }: { connection: LlmConnection }) {
  useTranslation(["llm"] as const);
  const warn = NEEDS_ACTION.has(connection.state);
  const degraded = connection.state === "degraded";
  const until =
    connection.state === "rate_limited" || degraded
      ? recoveryText(connection.retryAt)
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

interface LoginDialogProps {
  connector: LlmConnector;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Links an account the way the connector takes one. */
function LoginDialog(props: LoginDialogProps) {
  return props.connector.flow === "api_key" ? (
    <ApiKeyDialog {...props} />
  ) : (
    <DeviceLoginDialog {...props} />
  );
}

/** API key: the gateway checks it with the provider before keeping it. */
function ApiKeyDialog({ connector, open, onOpenChange }: LoginDialogProps) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const start = useStartLogin();
  const submit = useSubmitApiKey();
  const [apiKey, setApiKey] = useState("");
  const inputId = `api-key-${connector.id}`;
  const key = apiKey.trim();
  const keyUrl = connectorKeyUrl(connector.id);

  const save = () => {
    if (!key || submit.isPending) return;
    // A login attempt per key: the gateway checks the key as the attempt's input.
    start.mutate(
      { connector: connector.id },
      {
        onSuccess: ({ login }) =>
          submit.mutate(
            { id: login.id, apiKey: key },
            {
              onSuccess: ({ login: done }) => {
                if (done.status === "succeeded") {
                  toast.success(
                    translateText("apiKey.added", { name: connector.name }),
                  );
                  onOpenChange(false);
                }
              },
            },
          ),
      },
    );
  };
  const failure = start.error ?? submit.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {translateText("apiKey.title", { name: connector.name })}
            </DialogTitle>
            <DialogDescription>
              {keyUrl ? (
                <>
                  {translateText("connectorHints.geminiPrefix")}
                  <a
                    href={keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium underline underline-offset-2"
                  >
                    {translateText("connectorHints.geminiLink")}
                  </a>
                  {translateText("connectorHints.geminiSuffix")}
                </>
              ) : (
                (connectorHint(connector.id) ??
                translateText("apiKey.instructions"))
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <label htmlFor={inputId} className="text-xs font-medium">
              {translateText("apiKey.label")}
            </label>
            <Input
              id={inputId}
              type="password"
              value={apiKey}
              required
              autoComplete="off"
              spellCheck={false}
              aria-invalid={failure ? true : undefined}
              onChange={(event) => {
                setApiKey(event.target.value);
                if (start.isError) start.reset();
                if (submit.isError) submit.reset();
              }}
            />
          </div>
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {wireErrorMessage(failure)}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="submit"
              disabled={!key || start.isPending || submit.isPending}
            >
              {start.isPending || submit.isPending
                ? translateText("apiKey.checking")
                : translateText("apiKey.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Device-code login: show the code, open the provider page, wait. */
function DeviceLoginDialog({
  connector,
  open,
  onOpenChange,
}: LoginDialogProps) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const poll = useLoginPoll(start.data?.login.id);
  const login = poll.data ?? start.data?.login;
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef(false);

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      start.mutate({ connector: connector.id });
    }
  }, [open, connector.id, start]);
  useEffect(() => {
    if (!open || login?.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, login?.status]);
  useEffect(() => {
    if (login?.status === "succeeded") {
      toast.success(translateText("login.linked", { name: connector.name }));
      onOpenChange(false);
    }
  }, [login?.status, connector.name, onOpenChange, translateText]);

  const close = (next: boolean) => {
    if (!next && login?.status === "pending") cancel.mutate({ id: login.id });
    onOpenChange(next);
  };
  const retry = () => {
    startedRef.current = true;
    start.reset();
    start.mutate({ connector: connector.id });
  };
  const seconds = login
    ? Math.max(
        0,
        Math.round((new Date(login.expiresAt).getTime() - now) / 1000),
      )
    : 0;
  const failure = start.error ?? poll.error;
  const error = failure
    ? wireErrorMessage(failure)
    : login && login.status !== "pending" && login.status !== "succeeded"
      ? login.error
        ? llmProblemText(login.error)
        : translateText("login.failed")
      : undefined;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translateText("login.title", { name: connector.name })}
          </DialogTitle>
          <DialogDescription>
            {translateText("login.instructions")}
          </DialogDescription>
        </DialogHeader>
        {login?.userCode && !error ? (
          <div className="flex items-center justify-between gap-2 bg-muted px-3 py-2">
            <span
              className="font-mono text-2xl font-semibold tracking-widest"
              aria-label={translateText("login.codeLabel", {
                code: login.userCode,
              })}
            >
              {login.userCode}
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translateText("login.copyCode")}
              onClick={() =>
                navigator.clipboard
                  .writeText(login.userCode ?? "")
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
        {connectorHint(connector.id) ? (
          <p className="text-xs text-muted-foreground">
            {connectorHint(connector.id)}
          </p>
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
  quota,
  onRelogin,
  affectedAgents,
}: {
  connection: LlmConnection;
  connector: LlmConnector;
  quota: LlmQuota | undefined;
  onRelogin: () => void;
  affectedAgents: string[];
}) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const setEnabled = useSetEnabled();
  const remove = useRemoveConnection();
  const [confirming, setConfirming] = useState(false);
  const onError = (error: Error) => toast.error(wireErrorMessage(error));
  const disabled = connection.state === "disabled";
  const plan = quota?.plan || connection.plan;
  const relogin =
    connector.flow === "api_key"
      ? translateText("actions.reenterKey")
      : translateText("actions.signInAgain");

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
            {relogin}
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
            <DropdownMenuItem onSelect={onRelogin}>{relogin}</DropdownMenuItem>
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
          {llmProblemText(connection.error)}
        </p>
      ) : null}
      {connection.checkError?.code === "check_failed" ? (
        <p className="text-xs text-muted-foreground">
          {llmProblemText(connection.checkError)}
        </p>
      ) : null}
      {quota && !disabled ? <QuotaWindows quota={quota} /> : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("remove.confirmTitle", {
                account: connection.label,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {affectedAgents.length
                ? translateText("remove.affectedAgents", {
                    agents: affectedAgents.join(listSeparator()),
                    name: connector.name,
                  })
                : translateText("remove.credentialsNotice", {
                    name: connector.name,
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
                remove.mutate(
                  { id: connection.id },
                  {
                    onSuccess: () =>
                      toast.success(
                        translateText("remove.success", {
                          account: connection.label,
                        }),
                      ),
                    onError,
                  },
                )
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

/** Checks every account against its provider now; a failed check keeps the status shown. */
function RefreshStatus() {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const refresh = useRefreshLlm();
  const busy = refresh.isPending;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <p
        role="status"
        className={cn(
          "min-w-0 text-right text-xs empty:hidden",
          refresh.isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {busy
          ? translateText("refresh.checking")
          : refresh.isError
            ? translateText("refresh.failed", {
                message: wireErrorMessage(refresh.error),
              })
            : refresh.isSuccess
              ? translateText("refresh.done")
              : ""}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-busy={busy}
        disabled={busy}
        onClick={() => refresh.mutate({})}
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

function ConnectorSection({
  connector,
  connections,
  quota,
}: {
  connector: LlmConnector;
  connections: readonly LlmConnection[];
  quota: readonly LlmQuota[];
}) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const [login, setLogin] = useState(0);
  const { agents } = useAgents();
  const { models } = useLlm();
  const headingId = `connector-${connector.id}`;
  // Removing the last usable account takes this connector's models away.
  const affectedBy = (connection: LlmConnection) => {
    const others = connections.some(
      (other) => other.id !== connection.id && USABLE.has(other.state),
    );
    if (others) return [];
    const ids = new Set(
      models
        .filter((model) => model.connector === connector.id)
        .map((model) => `llm:${model.id}`),
    );
    return agents
      .filter((agent) => agent.model && ids.has(agent.model))
      .map((agent) =>
        translateText("common:format.quotedValue", { value: agent.name }),
      );
  };

  return (
    <section aria-labelledby={headingId} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          {connector.name}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setLogin((n) => n + 1)}
        >
          <PlusIcon aria-hidden="true" data-icon="inline-start" />
          {connector.flow === "api_key"
            ? translateText("actions.addKey")
            : translateText("actions.linkAccount")}
        </Button>
      </div>
      {connections.length ? (
        <ul
          aria-label={translateText("accounts.title", {
            name: connector.name,
          })}
          className="divide-y border"
        >
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              connector={connector}
              quota={quota.find((item) => item.connectionId === connection.id)}
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
 * The gateway's accounts: Codex and Grok subscriptions (device-code login), Gemini API keys, each
 * with its state and, for subscriptions, what is left of the 5-hour and weekly windows. Nothing
 * on a host without the gateway.
 */
export function LlmAccounts() {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const llm = useLlm();
  if (!llm.mounted) return null;
  return (
    <section aria-label={translateText("title")} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{translateText("title")}</h2>
        {llm.ready ? <RefreshStatus /> : null}
      </div>
      {llm.ready ? (
        llm.connectors.map((connector) => (
          <ConnectorSection
            key={connector.id}
            connector={connector}
            connections={llm.connections.filter(
              (connection) => connection.connector === connector.id,
            )}
            quota={llm.quota}
          />
        ))
      ) : (
        <Loading rows={2} />
      )}
    </section>
  );
}
