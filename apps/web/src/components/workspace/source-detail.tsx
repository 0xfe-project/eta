import type { ProviderKind } from "@eta/client-contracts";
import type { ReactNode } from "react";
import type { AccountSource, ProviderSource, Source } from "@/queries/sources";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
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
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { listSeparator } from "@/lib/i18n";
import { llmProblemText } from "@/lib/llm-problem";
import {
  USABLE,
  useLlm,
  useRefreshLlm,
  useRemoveConnection,
  useSetEnabled,
} from "@/queries/llm";
import {
  discoveryCodeText,
  isCustomKind,
  providerErrorMessage,
  signsIn,
  useCheckProviders,
  useDeleteProvider,
  useSaveProvider,
} from "@/queries/providers";
import { wireErrorMessage } from "@/queries/wire";
import { AccountLoginDialog } from "./account-login";
import { Select, SelectOption } from "./select-field";
import { AccountModels, ProviderModels } from "./source-models";
import { QuotaWindows, SourceLogo, StatusLabel } from "./source-parts";
import { protocolName, viaText } from "./source-text";
import { useAgents } from "./use-agents";

// One model source on a page of its own, under the list it came from: its models, and how it is
// connected. The models table writes as it changes; the connection (a key, an address, headers)
// is only written by "Save and check", which also tells whether it works.

/** The agents that would lose their model with these model ids, quoted for a sentence. */
function useAffectedAgents(models: ReadonlySet<string>): string[] {
  const { t: translateText } = useTranslation(["common"] as const);
  const { agents } = useAgents();
  return agents
    .filter((agent) => agent.model != null && models.has(agent.model))
    .map((agent) =>
      translateText("common:format.quotedValue", { value: agent.name }),
    );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <>
      <label
        htmlFor={htmlFor}
        className="text-xs text-muted-foreground max-sm:-mb-1"
      >
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </>
  );
}

const FIELDS =
  "grid max-w-2xl grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-x-3.5 gap-y-2 max-sm:grid-cols-1";

/**
 * Say that a check passed. A failed one needs no toast: the status beside the name changes, and
 * an unreachable source says why under it.
 */
function useAnnounceCheck() {
  const { t: translateText } = useTranslation(["providers"] as const);
  return (name: string, check: { state: string } | undefined) => {
    if (check?.state === "ok")
      toast.success(translateText("detail.checked.ok", { name }));
  };
}

function ProviderConnection({
  source,
  onRemoved,
}: {
  source: ProviderSource;
  onRemoved: () => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { provider } = source;
  const id = useId();
  const save = useSaveProvider();
  const check = useCheckProviders();
  const remove = useDeleteProvider();
  const announce = useAnnounceCheck();
  const [name, setName] = useState(provider.name ?? "");
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [kind, setKind] = useState<ProviderKind>(provider.kind);
  const [headers, setHeaders] = useState(
    Object.entries(provider.headers ?? {}).map(([header, value]) => ({
      name: header,
      value: value ?? "",
    })),
  );
  const [removing, setRemoving] = useState(false);
  const affected = useAffectedAgents(
    new Set(provider.models.map((model) => `${provider.id}:${model.id}`)),
  );
  const custom = isCustomKind(provider.kind);
  const legacy = signsIn(provider);
  const busy = save.isPending || check.isPending;

  const submit = () => {
    const trimmed = name.trim();
    save.mutate(
      {
        provider: {
          id: provider.id,
          ...(trimmed.length > 0 ? { name: trimmed } : {}),
          kind,
          baseUrl: baseUrl.trim(),
          // Absent keeps the saved key; null takes it away.
          ...(clearKey
            ? { apiKey: null }
            : key.trim().length > 0
              ? { apiKey: key.trim() }
              : {}),
          headers: Object.fromEntries(
            headers
              .map((row) => [row.name.trim(), row.value.trim()] as const)
              .filter(([header]) => header.length > 0)
              .map(([header, value]) => [
                header,
                value.length === 0 ? null : value,
              ]),
          ),
          models: provider.models,
        },
      },
      {
        onSuccess: () => {
          setKey("");
          setClearKey(false);
          check.mutate(
            { id: provider.id },
            {
              onSuccess: (result) =>
                result.checks[provider.id] === undefined
                  ? toast.success(translateText("common:feedback.saved"))
                  : announce(
                      trimmed || source.name,
                      result.checks[provider.id],
                    ),
              onError: (error) => toast.error(wireErrorMessage(error)),
            },
          );
        },
        onError: (error) => toast.error(providerErrorMessage(error)),
      },
    );
  };

  return (
    <form
      className="grid grid-cols-[minmax(0,1fr)] gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <fieldset
        disabled={busy}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3"
      >
        <div className={FIELDS}>
          <Field label={translateText("detail.name")} htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              value={name}
              placeholder={source.name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {legacy ? null : (
            <Field label={translateText("detail.key")} htmlFor={`${id}-key`}>
              <div className="flex items-center gap-2">
                <Input
                  id={`${id}-key`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  disabled={clearKey}
                  placeholder={
                    clearKey
                      ? translateText("detail.keyCleared")
                      : provider.hasApiKey
                        ? translateText("detail.keySaved")
                        : translateText("detail.keyMissing")
                  }
                  onChange={(event) => setKey(event.target.value)}
                />
                {custom && provider.hasApiKey ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setClearKey((current) => !current);
                      setKey("");
                    }}
                  >
                    {clearKey
                      ? translateText("detail.keepKey")
                      : translateText("detail.clearKey")}
                  </Button>
                ) : null}
              </div>
            </Field>
          )}
        </div>
        <details className="group" open={headers.length > 0 ? true : undefined}>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {translateText(
              custom ? "detail.advancedCustom" : "detail.advanced",
            )}
          </summary>
          <div className={`${FIELDS} mt-2`}>
            <Field
              label={translateText("detail.baseUrl")}
              htmlFor={`${id}-url`}
            >
              <Input
                id={`${id}-url`}
                className="font-mono"
                spellCheck={false}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
            {custom ? (
              <>
                <span
                  id={`${id}-protocol`}
                  className="text-xs text-muted-foreground"
                >
                  {translateText("detail.protocol")}
                </span>
                <Select
                  aria-labelledby={`${id}-protocol`}
                  value={kind}
                  onValueChange={(value) => setKind(value as ProviderKind)}
                  className="w-56"
                >
                  {(["openai-compatible", "openai-responses"] as const).map(
                    (choice) => (
                      <SelectOption key={choice} value={choice}>
                        {protocolName(choice)}
                      </SelectOption>
                    ),
                  )}
                </Select>
              </>
            ) : null}
            <span className="self-start pt-1.5 text-xs text-muted-foreground">
              {translateText("detail.headers")}
            </span>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
              {headers.map((row, at) => (
                <div
                  // Rows have no identity of their own until named; the position is the row.
                  // eslint-disable-next-line react/no-array-index-key
                  key={at}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-center gap-1.5"
                >
                  <Input
                    aria-label={translateText("detail.headerName")}
                    className="font-mono"
                    placeholder="User-Agent"
                    value={row.name}
                    onChange={(event) =>
                      setHeaders((current) =>
                        current.map((candidate, index) =>
                          index === at
                            ? { ...candidate, name: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label={translateText("detail.headerValue")}
                    className="font-mono"
                    value={row.value}
                    onChange={(event) =>
                      setHeaders((current) =>
                        current.map((candidate, index) =>
                          index === at
                            ? { ...candidate, value: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={translateText("common:actions.delete")}
                    onClick={() =>
                      setHeaders((current) =>
                        current.filter((_, index) => index !== at),
                      )
                    }
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="justify-self-start"
                onClick={() =>
                  setHeaders((current) => [...current, { name: "", value: "" }])
                }
              >
                ＋ {translateText("detail.addHeader")}
              </Button>
            </div>
          </div>
        </details>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || baseUrl.trim().length === 0}>
          {busy
            ? translateText("actions.checking")
            : translateText("actions.saveAndCheck")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => setRemoving(true)}
        >
          {translateText("actions.remove")}
        </Button>
      </div>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("remove.confirmTitle", {
                providerName: source.name,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {affected.length > 0
                ? translateText("remove.affectedAgents", {
                    agents: affected.join(listSeparator()),
                    providerName: source.name,
                  })
                : translateText("remove.credentialsNotice")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {translateText("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                remove.mutate(provider.id, {
                  onSuccess: () => {
                    toast.success(
                      translateText("remove.success", {
                        providerName: source.name,
                      }),
                    );
                    onRemoved();
                  },
                  onError: (error) => toast.error(providerErrorMessage(error)),
                })
              }
            >
              {translateText("common:actions.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}

function AccountConnection({
  source,
  onRemoved,
}: {
  source: AccountSource;
  onRemoved: () => void;
}) {
  const { t: translateText } = useTranslation([
    "providers",
    "llm",
    "common",
  ] as const);
  const { connection, connector, quota } = source;
  const llm = useLlm();
  const remove = useRemoveConnection();
  const setEnabled = useSetEnabled();
  const [signingIn, setSigningIn] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Signing out of the last usable account takes this connector's models away.
  const others = llm.connections.some(
    (other) =>
      other.id !== connection.id &&
      other.connector === connector.id &&
      USABLE.has(other.state),
  );
  const affected = useAffectedAgents(
    new Set(
      others
        ? []
        : llm.models
            .filter((model) => model.connector === connector.id)
            .map((model) => `llm:${model.id}`),
    ),
  );
  const plan = quota?.plan || connection.plan;
  const onError = (error: Error) => toast.error(wireErrorMessage(error));
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <div className={FIELDS}>
        <Field label={translateText("detail.account")}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 truncate">{connection.label}</span>
            {plan ? (
              <Badge variant="secondary" className="capitalize">
                {plan}
              </Badge>
            ) : null}
            {source.status === "disabled" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={setEnabled.isPending}
                onClick={() =>
                  setEnabled.mutate(
                    { id: connection.id, enabled: true },
                    { onError },
                  )
                }
              >
                {translateText("common:actions.enable")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSigningIn(true)}
            >
              {connector.flow === "api_key"
                ? translateText("llm:actions.reenterKey")
                : translateText("llm:actions.signInAgain")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setRemoving(true)}
            >
              {translateText("actions.signOut")}
            </Button>
          </div>
        </Field>
      </div>
      {quota !== undefined && source.status !== "disabled" ? (
        <QuotaWindows quota={quota} />
      ) : null}
      {signingIn ? (
        <AccountLoginDialog
          connector={connector}
          onClose={() => setSigningIn(false)}
        />
      ) : null}
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {translateText("llm:remove.confirmTitle", {
                account: connection.label,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {affected.length > 0
                ? translateText("llm:remove.affectedAgents", {
                    agents: affected.join(listSeparator()),
                    name: connector.name,
                  })
                : translateText("llm:remove.credentialsNotice", {
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
                    onSuccess: () => {
                      toast.success(
                        translateText("llm:remove.success", {
                          account: connection.label,
                        }),
                      );
                      onRemoved();
                    },
                    onError,
                  },
                )
              }
            >
              {translateText("actions.signOut")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Why a source is not working, when the host or the gateway said. */
function problemOf(source: Source): string | undefined {
  if (source.type === "account") {
    const problem =
      source.connection.state === "disabled"
        ? undefined
        : (source.connection.error ??
          (source.connection.checkError?.code === "check_failed"
            ? source.connection.checkError
            : undefined));
    return problem === undefined ? undefined : llmProblemText(problem);
  }
  if (source.check?.state !== "unreachable" || source.check.error === undefined)
    return undefined;
  return discoveryCodeText(source.check.error);
}

export function SourceDetail({
  source,
  logo,
  onBack,
}: {
  source: Source;
  logo: string | undefined;
  onBack: () => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const check = useCheckProviders();
  const refreshLlm = useRefreshLlm();
  const announce = useAnnounceCheck();
  const [tab, setTab] = useState("models");
  const checking = check.isPending || refreshLlm.isPending;
  const runCheck = () => {
    if (source.type === "account") {
      refreshLlm.mutate(
        {},
        { onError: (error) => toast.error(wireErrorMessage(error)) },
      );
      return;
    }
    check.mutate(
      { id: source.provider.id },
      {
        onSuccess: (result) =>
          announce(source.name, result.checks[source.provider.id]),
        onError: (error) => toast.error(wireErrorMessage(error)),
      },
    );
  };
  const problem = problemOf(source);
  const enabled =
    source.type === "provider" ? source.provider.models.length : source.models;
  return (
    <div className="min-w-0">
      <nav
        aria-label={translateText("detail.breadcrumb")}
        className="mb-2.5 text-xs text-muted-foreground"
      >
        <button
          type="button"
          className="hover:text-foreground"
          onClick={onBack}
        >
          {translateText("title")}
        </button>
        <span aria-hidden="true"> / </span>
        <span aria-current="page">{source.name}</span>
      </nav>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <SourceLogo name={source.name} svg={logo} />
        <h2 className="truncate text-sm font-semibold">{source.name}</h2>
        <span className="truncate text-xs text-faint">
          {viaText(source)}
          {source.type === "account" ? ` · ${source.connection.label}` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <StatusLabel status={source.status} />
          {source.type === "provider" &&
          (source.via === "legacy" || source.status === "needs_key") ? null : (
            <Button
              size="sm"
              variant="ghost"
              disabled={checking}
              aria-busy={checking}
              onClick={runCheck}
            >
              {checking
                ? translateText("actions.checking")
                : translateText("actions.check")}
            </Button>
          )}
        </span>
      </div>
      {problem === undefined ? null : (
        <p role="status" className="mt-1 text-xs text-state-error">
          {problem}
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab} className="mt-3">
        <TabsList>
          <TabsTrigger value="models">
            {translateText("detail.tabs.models")}
            <span className="tabular-nums text-muted-foreground">
              {enabled}
            </span>
          </TabsTrigger>
          <TabsTrigger value="connection">
            {translateText("detail.tabs.connection")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="models" className="mt-1">
          {source.type === "provider" ? (
            <ProviderModels provider={source.provider} />
          ) : (
            <AccountModels connector={source.connector} />
          )}
        </TabsContent>
        <TabsContent value="connection" className="mt-1">
          {source.type === "provider" ? (
            <ProviderConnection
              key={source.provider.id}
              source={source}
              onRemoved={onBack}
            />
          ) : (
            <AccountConnection source={source} onRemoved={onBack} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
