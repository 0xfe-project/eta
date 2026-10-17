import type { GitHubStatus, Installation } from "@/queries/forge";

import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/CheckCircle";
import { GitBranchIcon } from "@phosphor-icons/react/GitBranch";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useId, useState } from "react";
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
import { listSeparator, translate } from "@/lib/i18n";
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

const steps = [
  "connections:github.steps.overview",
  "connections:github.steps.createApp",
  "connections:github.steps.install",
  "common:actions.done",
] as const;
type Step = 0 | 1 | 2 | 3;

/** Where the setup stands on the server; steps before it are done. */
function serverStep(status: GitHubStatus | undefined): Step {
  if (!status || status.state === "not_connected") return 0;
  return status.state === "ready" ? 3 : 2;
}

const features = [
  [GitBranchIcon, "connections:github.features.git"],
  [GitPullRequestIcon, "connections:github.features.gh"],
] as const;

function Intro() {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
  return (
    <div className="space-y-3">
      <p className="text-sm">{translateText("github.introduction")}</p>
      <ul className="space-y-2">
        {features.map(([Icon, text]) => (
          <li key={text} className="flex items-center gap-2.5 text-sm">
            <span className="flex size-7 shrink-0 items-center justify-center bg-muted">
              <Icon aria-hidden="true" className="size-4" />
            </span>
            {translateText(text)}
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
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
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
        <legend className="mb-2 text-sm font-medium">
          {translateText("github.fields.ownerLabel")}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              [
                "user",
                translateText("github.fields.personalAccount"),
                translateText("github.fields.personalAccountHint"),
              ],
              [
                "organization",
                translateText("github.fields.organization"),
                translateText("github.fields.organizationHint"),
              ],
            ] as const
          ).map(([value, label, hint]) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 border p-3 hover:bg-muted/50 has-focus-visible:ring-1 has-focus-visible:ring-ring",
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
              {translateText("github.fields.organizationName")}
            </label>
            <Input
              id={orgId}
              value={organization}
              placeholder={translateText(
                "github.fields.organizationPlaceholder",
              )}
              maxLength={39}
              required
              pattern={String.raw`.*\S.*`}
              spellCheck={false}
              autoFocus
              onInvalid={(e) =>
                e.currentTarget.setCustomValidity(
                  translateText("validation:organizationRequired"),
                )
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
          {translateText("github.fields.appName")}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {translateText("common:labels.optional")}
          </span>
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={34}
          placeholder={translateText("github.fields.appNamePlaceholder")}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {translateText("github.fields.appNameHint")}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translateText("github.createApp.redirectHelp")}
      </p>
    </form>
  );
}

function Install({ status }: { status: GitHubStatus }) {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
  const app = status.app!;
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {translateText("common:entities.app")}{" "}
        <a
          href={app.html_url}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          {app.name}
        </a>
        {translateText("github.install.createdPrefix")}
      </p>
      <ol className="space-y-2">
        {[
          translateText("github.install.chooseAccount"),
          translateText("github.install.chooseRepositories"),
          translateText("github.install.authorize"),
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
  if (installation.repository_selection === "all")
    return translate("connections:github.repositories.all");
  const shown = installation.repositories
    .slice(0, 3)
    .map((name) => name.split("/")[1]);
  if (!shown.length) return translate("connections:github.repositories.none");
  const more = installation.total_repositories - shown.length;
  return more > 0
    ? translate("connections:github.repositories.more", {
        names: shown.join(listSeparator()),
        count: installation.total_repositories,
      })
    : shown.join(listSeparator());
}

function Done({ status }: { status: GitHubStatus }) {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
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
          <p className="text-sm font-medium">
            {translateText("status.connected")}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.user
              ? translateText("github.identity.commitAuthorPrefix", {
                  username: status.user.login,
                })
              : translateText("github.identity.appPrefix")}
            <a
              href={app.html_url}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-2"
            >
              {app.slug}[bot]
            </a>
            {status.user
              ? translateText("common:format.period")
              : translateText("github.identity.appSuffix")}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <ul
          aria-label={translateText("github.install.accounts")}
          className="divide-y border"
        >
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
                      ? translateText("github.accountType.organization")
                      : translateText("github.accountType.personal")}
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
                    {translateText("common:actions.manage")}
                    <ArrowSquareOutIcon aria-hidden="true" />
                  </a>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        <Button asChild variant="link" size="sm" className="h-auto px-0">
          <a href={app.install_url}>
            {translateText("github.install.otherAccount")}
          </a>
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
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
  const authorize = useAuthorizeGitHub();
  const unauthorize = useUnauthorizeGitHub();
  const onError = (error: Error) => toast.error(error.message);
  if (status.user) {
    return (
      <section className="flex items-center gap-3 border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {translateText("github.identity.agentLabel", {
              name: status.user.login,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {translateText("github.authorization.identityHelp")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={unauthorize.isPending}
          onClick={() => unauthorize.mutate(undefined, { onError })}
        >
          {translateText("github.authorization.revoke")}
        </Button>
      </section>
    );
  }
  return (
    <section className="space-y-3 border px-3 py-2.5">
      <div>
        <p className="text-sm font-medium">
          {translateText("github.authorization.title")}
        </p>
        <p className="text-xs text-muted-foreground">
          {translateText("github.authorization.description")}
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
        {authorize.isPending
          ? translateText("github.authorization.opening")
          : translateText("github.authorization.open")}
      </Button>
    </section>
  );
}

function OAuthClientForm({ settingsURL }: { settingsURL: string }) {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
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
        {translateText("github.oauth.legacyAppHelp")}
        <a
          href={settingsURL}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          {translateText("github.oauth.appSettings")}
        </a>
        {translateText("github.oauth.callbackPrefix")}
        <code className="break-all text-foreground">
          {window.location.origin + authorizationCallbackPath}
        </code>
        {translateText("github.oauth.clientSecretHelp")}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={idId} className="text-xs font-medium">
            {translateText("github.oauth.clientId")}
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
            {translateText("github.oauth.clientSecret")}
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
        {translateText("common:actions.save")}
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
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
  const disconnect = useDisconnectGitHub();
  const app = status.app!;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" className="text-muted-foreground sm:mr-auto">
          {translateText("actions.disconnect")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {translateText("github.disconnect.confirmTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {translateText("github.disconnect.confirmDescription", {
              appName: app.name,
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
              disconnect.mutate(undefined, {
                onSuccess: () =>
                  toast.success(translateText("github.disconnect.success"), {
                    action: {
                      label: translateText("github.disconnect.deleteApp"),
                      onClick: () => window.open(app.settings_url, "_blank"),
                    },
                  }),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            {translateText("common:actions.disconnect")}
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
  const { t: translateText } = useTranslation([
    "connections",
    "common",
    "validation",
  ] as const);
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
      what={translateText("github.status.label")}
      error={error}
      onRetry={() => void refetch()}
    />
  ) : isPending ? (
    <Loading layout="lines" />
  ) : status.state === "error" ? (
    <Alert>
      {status.error?.message ?? translateText("github.errors.connectionFailed")}
    </Alert>
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
          {translateText("common:actions.retry")}
        </Button>
      </>
    );
  } else if (status && step === 0) {
    footer = (
      <Button onClick={() => setLocal(1)}>
        {translateText("actions.connect")}
      </Button>
    );
  } else if (status && step === 1) {
    footer = (
      <>
        <Button
          variant="ghost"
          className="sm:mr-auto"
          onClick={() => setLocal(0)}
        >
          {translateText("common:actions.previous")}
        </Button>
        <Button type="submit" form="github-create" disabled={create.isPending}>
          <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
          {create.isPending
            ? translateText("github.authorization.opening")
            : translateText("github.actions.create")}
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
          {translateText("github.actions.confirmInstalled")}
        </Button>
        <Button asChild>
          <a href={status.app!.install_url}>
            <GithubLogoIcon aria-hidden="true" data-icon="inline-start" />
            {translateText("github.actions.install")}
          </a>
        </Button>
      </>
    );
  } else if (status && step === 3) {
    footer = (
      <>
        <Disconnect status={status} />
        <Button onClick={() => onOpenChange(false)}>
          {translateText("common:actions.done")}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-2">
          <GithubLogoIcon aria-hidden="true" className="size-5" />
          <DialogTitle className="text-sm">
            {translateText("github.title")}
          </DialogTitle>
        </DialogHeader>
        <Stepper
          steps={steps.map((key) => translateText(key))}
          step={step}
          label={translateText("github.steps.label")}
          complete={step === 3}
        />
        <div className="min-h-64">{body}</div>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
