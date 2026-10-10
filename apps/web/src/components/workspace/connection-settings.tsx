import type { GitHubStatus } from "@/queries/forge";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoadError, Loading } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGitHubStatus, useRefreshGitHub } from "@/queries/forge";
import {
  GROK_CONNECTOR,
  useConnections,
  useConnectors,
  useUsage,
} from "@/queries/llm";
import { GitHubWizard } from "./github-wizard";
import { ConnectorSection } from "./provider-settings";

/** What the GitHub App does now, and what is left for the user to do. */
function githubSummary(status: GitHubStatus): {
  summary: string;
  todo?: string;
} {
  switch (status.state) {
    case "ready":
      return {
        summary: status.user
          ? `以 ${status.user.login} 的名义打开 PR，以 ${status.app?.slug}[bot] 的身份推送代码`
          : `以 ${status.app?.slug}[bot] 的身份推送代码和打开 PR`,
      };
    case "not_installed":
      return { summary: "App 已创建，还需安装到仓库", todo: "待安装" };
    case "error":
      return { summary: status.error?.message ?? "连接出错", todo: "出错" };
    default:
      return {
        summary: "推送代码、以 App 身份打开 PR、读取 CI",
        todo: "未连接",
      };
  }
}

// Query parameters GitHub and the forge service send the browser back with.
const RETURN_PARAMS = [
  "github",
  "github_error",
  "installation_id",
  "setup_action",
];

/**
 * Coming back from GitHub (App created, installed or failed): reopen the
 * wizard where it now stands and drop the parameters from the address.
 */
function useReturnFromGitHub(onReturn: (error: string | undefined) => void) {
  const refresh = useRefreshGitHub();
  useEffect(() => {
    const url = new URL(window.location.href);
    const params = url.searchParams;
    if (!RETURN_PARAMS.some((name) => params.has(name))) return;
    const error = params.get("github_error") ?? undefined;
    if (!error && params.get("github") === "created")
      toast.success("GitHub App 已创建");
    else if (!error && params.get("github") === "authorized")
      toast.success("已授权，PR 将以你的名义打开");
    else if (!error && params.get("setup_action"))
      toast.success("已在 GitHub 上安装 App");
    for (const name of RETURN_PARAMS) params.delete(name);
    window.history.replaceState(window.history.state, "", url);
    onReturn(error);
    void refresh();
  }, [onReturn, refresh]);
}

function GitHubConnection() {
  const { data: status, error, refetch } = useGitHubStatus();
  const [open, setOpen] = useState(false);
  const [returned, setReturned] = useState<{ error?: string }>();
  useReturnFromGitHub(
    useCallback((error: string | undefined) => {
      setReturned({ error });
      setOpen(true);
    }, []),
  );
  const current = status ? githubSummary(status) : undefined;

  return (
    <section aria-labelledby="connection-github" className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id="connection-github" className="text-sm font-medium">
          GitHub
        </h3>
        <Button
          size="sm"
          variant="outline"
          disabled={!status}
          onClick={() => setOpen(true)}
        >
          {status?.app ? "管理" : "连接"}
        </Button>
      </div>
      {error && !status ? (
        <LoadError
          what="GitHub 的连接状态"
          error={error}
          onRetry={() => void refetch()}
          className="border py-4"
        />
      ) : current ? (
        <p className="flex items-center gap-2 border px-3 py-2.5 text-xs text-muted-foreground">
          {current.todo ? (
            <Badge variant="outline" className="shrink-0">
              {current.todo}
            </Badge>
          ) : null}
          <span className="min-w-0">{current.summary}</span>
        </p>
      ) : (
        <Loading layout="lines" rows={1} className="border px-3 py-3" />
      )}
      <GitHubWizard
        // A return from GitHub starts the wizard over where it now stands.
        key={returned ? `returned-${returned.error ?? ""}` : "wizard"}
        open={open}
        onOpenChange={setOpen}
        returnError={returned?.error}
      />
    </section>
  );
}

/**
 * Grok's account is the model gateway's xAI account: the same one serves
 * Grok models and the grok plugin's images, videos and search.
 */
function GrokConnection() {
  const connectors = useConnectors();
  const connections = useConnections();
  const { data: usage } = useUsage();
  const connector = connectors.data?.find((item) => item.id === GROK_CONNECTOR);

  if (connectors.error)
    return (
      <LoadError
        what="Grok"
        error={connectors.error}
        onRetry={() => void connectors.refetch()}
        className="border py-4"
      />
    );
  if (connectors.isPending) return <Loading rows={1} />;
  if (!connector) return null;
  return (
    <>
      {connections.error ? (
        <p role="alert" className="text-xs text-destructive">
          无法加载账号：{connections.error.message}
        </p>
      ) : null}
      <ConnectorSection
        connector={connector}
        connections={(connections.data ?? []).filter(
          (connection) => connection.connector === GROK_CONNECTOR,
        )}
        usage={usage}
      />
    </>
  );
}

/** Settings → 连接: the integrations the user has to set up themselves. */
export function ConnectionSettings() {
  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold">连接</h2>
      <GitHubConnection />
      <GrokConnection />
    </div>
  );
}
