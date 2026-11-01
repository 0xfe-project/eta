import type { ProviderSummary } from "@eta/client-contracts";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/DotsThree";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  keyMissing,
  providerErrorMessage,
  providerLabel,
  signsIn,
  useAnswerLogin,
  useCancelLogin,
  useLoginStatus,
  useProviders,
  useRefreshProvider,
  useStartLogin,
} from "@/queries/providers";
import { LlmAccounts } from "./llm-accounts";
import { ProviderEditor } from "./provider-editor";

/** Device-code sign-in to Codex: show the code, open the page, wait. */
function LoginDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const answer = useAnswerLogin();
  const status = useLoginStatus(start.data?.login.id);
  const login = status.data ?? start.data?.login;
  const [typed, setTyped] = useState("");
  const startedRef = useRef(false);
  const providerName = providerLabel(provider);

  useEffect(() => {
    if (open && !startedRef.current) {
      startedRef.current = true;
      start.mutate({ method: "device_code" });
    }
  }, [open, start]);
  useEffect(() => {
    if (login?.status === "complete") {
      toast.success(translateText("login.linked", { providerName }));
      onOpenChange(false);
    }
  }, [login?.status, providerName, onOpenChange, translateText]);

  const close = (next: boolean) => {
    if (!next && login?.status === "pending") cancel.mutate({ id: login.id });
    onOpenChange(next);
  };
  const retry = () => {
    start.reset();
    start.mutate({ method: "device_code" });
  };
  const failure = start.error ?? status.error;
  const error = failure
    ? providerErrorMessage(failure)
    : login && (login.status === "failed" || login.status === "cancelled")
      ? translateText("login.failed")
      : undefined;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translateText("login.title", { providerName })}
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
              ? translateText("login.waiting")
              : translateText("login.loadingCode")}
          </p>
        )}
        {login?.manualPromptId && !error ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!login.manualPromptId || !typed.trim()) return;
              answer.mutate(
                {
                  id: login.id,
                  promptId: login.manualPromptId,
                  value: typed.trim(),
                },
                {
                  onSuccess: () => setTyped(""),
                  onError: (failed) =>
                    toast.error(providerErrorMessage(failed)),
                },
              );
            }}
          >
            <Input
              value={typed}
              autoComplete="off"
              spellCheck={false}
              aria-label={translateText("login.manualLabel")}
              placeholder={translateText("login.manualLabel")}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button
              type="submit"
              variant="outline"
              disabled={!typed.trim() || answer.isPending}
            >
              {translateText("login.continue")}
            </Button>
          </form>
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

function ProviderRow({
  provider,
  onEdit,
}: {
  provider: ProviderSummary;
  onEdit: () => void;
}) {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const refresh = useRefreshProvider();
  const [login, setLogin] = useState(0);
  const providerName = providerLabel(provider);
  const required = keyMissing(provider);

  return (
    <li className="flex min-w-0 items-center gap-2 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs">{provider.id}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {provider.kind} · {provider.baseUrl} ·{" "}
          {translateText("editor.modelCount", {
            count: provider.models.length,
          })}
          {provider.hasApiKey || signsIn(provider) ? null : (
            <span
              className={
                required
                  ? "inline-flex items-center gap-1 text-destructive"
                  : ""
              }
            >
              {" · "}
              {required ? (
                <WarningIcon aria-hidden="true" className="size-3" />
              ) : null}
              {translateText("editor.keyMissing")}
            </span>
          )}
        </span>
      </span>
      {signsIn(provider) ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() => setLogin((n) => n + 1)}
        >
          {translateText("actions.linkAccount")}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        aria-label={translateText("common:actions.editItem", {
          name: providerName,
        })}
        onClick={onEdit}
      >
        {translateText("common:actions.edit")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translateText("common:accessibility.itemActions", {
              name: providerName,
            })}
          >
            <DotsThreeIcon aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {signsIn(provider) ? null : (
            <DropdownMenuItem
              disabled={refresh.isPending}
              onSelect={() =>
                refresh.mutate(
                  { id: provider.id },
                  {
                    onSuccess: ({ models }) =>
                      toast.success(
                        translateText("refresh.done", {
                          providerName,
                          count: models,
                        }),
                      ),
                    onError: (error) =>
                      toast.error(providerErrorMessage(error)),
                  },
                )
              }
            >
              {translateText("actions.refreshModels")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {login ? (
        // Keyed so every open starts a fresh sign-in.
        <LoginDialog
          key={login}
          provider={provider}
          open
          onOpenChange={(open) => !open && setLogin(0)}
        />
      ) : null}
    </li>
  );
}

/**
 * Settings → 模型服务: the providers in the config file, as rows you can edit.
 *
 * One row, one editor: a provider is one object in the file and the form is that object. What a
 * row says about a provider is what the config says (its kind, endpoint, models, whether a key is
 * set); the host reports nothing about whether an account works, so nothing here claims it does.
 */
export function ProviderSettings() {
  const { t: translateText } = useTranslation(["providers", "common"] as const);
  const { data, error } = useProviders();
  const [editing, setEditing] = useState<ProviderSummary | "new" | undefined>(
    undefined,
  );
  if (error) return <LoadError what={translateText("title")} error={error} />;
  // Editing replaces the list: it is one row's worth of the same column, and a person who is
  // looking at a form is not also choosing which provider to edit.
  if (editing !== undefined)
    return (
      <ProviderEditor
        key={editing === "new" ? "new" : editing.id}
        // The row as it is now, so a save shows in the editor that made it.
        provider={
          editing === "new"
            ? undefined
            : (data?.providers.find(
                (candidate) => candidate.id === editing.id,
              ) ?? editing)
        }
        onClose={() => setEditing(undefined)}
      />
    );
  return (
    <div className="space-y-4">
      <LlmAccounts />
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{translateText("title")}</h2>
          <Button
            size="sm"
            variant="outline"
            disabled={!data}
            onClick={() => setEditing("new")}
          >
            <PlusIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("editor.newTitle")}
          </Button>
        </div>
        {!data ? (
          <Loading rows={2} />
        ) : data.providers.length === 0 ? (
          <p className="border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
            {translateText("editor.empty")}
          </p>
        ) : (
          <ul
            aria-label={translateText("editor.configured")}
            className="divide-y border"
          >
            {data.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                onEdit={() => setEditing(provider)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
