import type { LlmConnector, LlmLogin } from "@eta/client-contracts";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { llmProblemText } from "@/lib/llm-problem";
import {
  useCancelLogin,
  useLoginPoll,
  useStartLogin,
  useSubmitApiKey,
} from "@/queries/llm";
import { wireErrorMessage } from "@/queries/wire";
import { connectorHint, connectorKeyUrl } from "./llm-state";

// Signing in to an account the LLM gateway holds: a device code for a subscription (Codex, Grok),
// a key the gateway checks with the provider (Google AI Studio). The same two panels serve adding
// a source and signing an existing one in again.

/**
 * Device-code sign-in: the code, the page to enter it on, and a wait that ends by itself. Started
 * once when shown; leaving while it waits cancels it.
 */
export function DeviceLogin({
  connector,
  onDone,
}: {
  connector: LlmConnector;
  onDone: (login: LlmLogin) => void;
}) {
  const { t: translateText } = useTranslation(["llm", "common"] as const);
  const start = useStartLogin();
  const cancel = useCancelLogin();
  const poll = useLoginPoll(start.data?.login.id);
  const login = poll.data ?? start.data?.login;
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef(false);
  const pendingRef = useRef<string | undefined>(undefined);
  pendingRef.current = login?.status === "pending" ? login.id : undefined;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    start.mutate({ connector: connector.id });
  }, [connector.id, start]);
  const cancelRef = useRef(cancel.mutate);
  cancelRef.current = cancel.mutate;
  // Only on leaving: the pending id is read from the ref at that moment.
  useEffect(
    () => () => {
      if (pendingRef.current !== undefined)
        cancelRef.current({ id: pendingRef.current });
    },
    [],
  );
  useEffect(() => {
    if (login?.status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [login?.status]);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (login?.status === "succeeded") doneRef.current(login);
  }, [login]);

  const retry = () => {
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <p className="text-xs text-muted-foreground">
        {translateText("login.instructions")}
      </p>
      {login?.userCode && !error ? (
        <div className="flex items-center justify-between gap-2 bg-surface px-3 py-2">
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
              void navigator.clipboard
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
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={retry}
            disabled={start.isPending}
          >
            {translateText("common:actions.retry")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild size="sm" disabled={!login?.url}>
            <a href={login?.url} target="_blank" rel="noreferrer">
              <ArrowSquareOutIcon aria-hidden="true" data-icon="inline-start" />
              {translateText("login.openAuthorization")}
            </a>
          </Button>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {login
              ? translateText("login.waitingWithExpiry", {
                  minutes: Math.floor(seconds / 60),
                  seconds: String(seconds % 60).padStart(2, "0"),
                })
              : translateText("login.loadingCode")}
          </p>
        </div>
      )}
      {connectorHint(connector.id) ? (
        <p className="text-xs text-muted-foreground">
          {connectorHint(connector.id)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A key the gateway holds: it is checked with the provider before it is kept. The form is
 * submitted by whatever button names `formId`, so a dialog's footer can carry it.
 */
export function GatewayKeyForm({
  connector,
  formId,
  onDone,
  onPendingChange,
}: {
  connector: LlmConnector;
  formId: string;
  onDone: () => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t: translateText } = useTranslation(["llm", "providers"] as const);
  const start = useStartLogin();
  const submit = useSubmitApiKey();
  const [apiKey, setApiKey] = useState("");
  const inputId = `${formId}-key`;
  const key = apiKey.trim();
  const keyUrl = connectorKeyUrl(connector.id);
  const pending = start.isPending || submit.isPending;
  const pendingChangeRef = useRef(onPendingChange);
  pendingChangeRef.current = onPendingChange;
  useEffect(() => pendingChangeRef.current?.(pending), [pending]);

  const save = () => {
    if (!key || pending) return;
    // A login attempt per key: the gateway checks the key as the attempt's input.
    start.mutate(
      { connector: connector.id },
      {
        onSuccess: ({ login }) =>
          submit.mutate(
            { id: login.id, apiKey: key },
            {
              onSuccess: ({ login: done }) => {
                if (done.status === "succeeded") onDone();
              },
            },
          ),
      },
    );
  };
  const failure = start.error ?? submit.error;
  return (
    <form
      id={formId}
      className="grid grid-cols-[minmax(0,1fr)] gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label htmlFor={inputId} className="text-xs text-muted-foreground">
        {translateText("providers:add.keyLabel", { name: connector.name })}
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
      {keyUrl ? (
        <p className="text-xs text-muted-foreground">
          {translateText("connectorHints.geminiPrefix")}
          <a
            href={keyUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {translateText("connectorHints.geminiLink")}
          </a>
          {translateText("connectorHints.geminiSuffix")}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-xs text-destructive">
          {wireErrorMessage(failure)}
        </p>
      ) : null}
    </form>
  );
}

/** Sign an account in again, the way its connector takes one. Opened from a source's detail. */
export function AccountLoginDialog({
  connector,
  onClose,
}: {
  connector: LlmConnector;
  onClose: () => void;
}) {
  const { t: translateText } = useTranslation(["llm", "providers"] as const);
  const formId = `relogin-${connector.id}`;
  const [pending, setPending] = useState(false);
  const done = () => {
    toast.success(translateText("login.linked", { name: connector.name }));
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100%-2rem)] gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translateText("login.title", { name: connector.name })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {translateText("login.title", { name: connector.name })}
          </DialogDescription>
        </DialogHeader>
        {connector.flow === "api_key" ? (
          <>
            <GatewayKeyForm
              connector={connector}
              formId={formId}
              onDone={done}
              onPendingChange={setPending}
            />
            <DialogFooter>
              <Button type="submit" form={formId} disabled={pending}>
                {pending
                  ? translateText("providers:add.connecting")
                  : translateText("providers:add.connect")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <DeviceLogin connector={connector} onDone={done} />
        )}
      </DialogContent>
    </Dialog>
  );
}
