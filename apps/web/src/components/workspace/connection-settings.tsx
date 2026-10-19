import type { GitHubStatus } from "@eta/client-contracts";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { translate } from "@/lib/i18n";
import { useGitHubStatus, useKeepGitHubFresh } from "@/queries/github";
import { GitHubWizard } from "./github-wizard";

// Settings → 连接: the accounts the user connects eta to. Today that is GitHub: the App agents act
// as, which the wizard creates, installs and (when the user authorizes it) lets them act through.
// GitHub sends the browser back here after creating or authorizing the App, with what happened in
// the address; the page reopens the wizard where it now stands.

interface Summary {
  summary: string;
  /** Set when the user has something to do. */
  todo?: string;
}

/** What the GitHub App does now, and what is left for the user to do. */
function githubSummary(status: GitHubStatus): Summary {
  switch (status.state) {
    case "ready":
      return {
        summary: status.user
          ? translate("connections:github.identity.user", {
              username: status.user.login,
            })
          : translate("connections:github.identity.bot", {
              appName: status.app?.slug,
            }),
      };
    case "not_installed":
      return {
        summary: translate("connections:github.status.createdNotInstalled"),
        todo: translate("connections:github.status.awaitingInstallation"),
      };
    case "error":
      return {
        summary: status.error?.message ?? translate("connections:status.error"),
        todo: translate("common:status.error"),
      };
    default:
      return {
        summary: translate("connections:github.summary"),
        todo: translate("connections:status.notConnected"),
      };
  }
}

// Query parameters GitHub and the host send the browser back with.
const RETURN_PARAMS = [
  "github",
  "github_error",
  "installation_id",
  "setup_action",
];

/**
 * Coming back from GitHub (App created, installed or failed): reopen the wizard where it now
 * stands and drop the parameters from the address.
 */
function useReturnFromGitHub(onReturn: (error: string | undefined) => void) {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
  ] as const);
  const { refresh } = useGitHubStatus();
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (!RETURN_PARAMS.some((name) => params.has(name))) return;
    const error = params.get("github_error") ?? undefined;
    if (!error && params.get("github") === "created")
      toast.success(translateText("github.feedback.appCreated"));
    else if (!error && params.get("github") === "authorized")
      toast.success(translateText("github.feedback.authorized"));
    else if (!error && params.get("setup_action"))
      toast.success(translateText("github.feedback.appInstalled"));
    for (const name of RETURN_PARAMS) params.delete(name);
    window.history.replaceState(window.history.state, "", url);
    onReturn(error);
    refresh();
  }, [onReturn, refresh, translateText]);
}

function GitHubConnection() {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
  ] as const);
  const { status, unavailable } = useGitHubStatus();
  useKeepGitHubFresh();
  const [open, setOpen] = useState(false);
  const [returned, setReturned] = useState<{ error?: string }>();
  useReturnFromGitHub(
    useCallback((error: string | undefined) => {
      setReturned({ error });
      setOpen(true);
    }, []),
  );
  // Loading shows what it is for; the wizard shows a failed load in full.
  const current: Summary = status?.checked
    ? githubSummary(status)
    : unavailable
      ? {
          summary: translateText("errors.loadStatus"),
          todo: translateText("common:status.error"),
        }
      : { summary: translateText("github.summary") };
  const connected = status !== undefined && status.state !== "not_connected";

  return (
    <li className="flex items-start gap-3 px-3 py-2 text-sm">
      <GithubLogoIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
          GitHub
          {current.todo ? (
            <Badge variant="outline">{current.todo}</Badge>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{current.summary}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${
          connected
            ? translateText("common:actions.manage")
            : translateText("actions.connect")
        } GitHub`}
        onClick={() => setOpen(true)}
      >
        {connected
          ? translateText("common:actions.manage")
          : translateText("actions.connect")}
      </Button>
      <GitHubWizard
        // A return from GitHub starts the wizard over where it now stands.
        key={returned ? `returned-${returned.error ?? ""}` : "wizard"}
        open={open}
        onOpenChange={setOpen}
        returnError={returned?.error}
      />
    </li>
  );
}

/** Settings → 连接. */
export function ConnectionSettings() {
  const { t: translateText } = useTranslation([
    "connections",
    "common",
  ] as const);
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">{translateText("title")}</h2>
      <ul aria-label={translateText("title")} className="divide-y border">
        <GitHubConnection />
      </ul>
    </div>
  );
}
