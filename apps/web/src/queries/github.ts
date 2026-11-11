import type {
  GitHubArgs,
  GitHubResults,
  GitHubStatus,
  TaskPullView,
} from "@eta/client-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { getWire } from "@/lib/wire";
import { useTarget, useWireMutation, useWireState } from "@/queries/wire";

// The GitHub App on the wire: the `github` target (`state`, the wizard's view of the connection;
// `pulls`, the pull requests tasks delivered) and its calls. The App's key, its secrets and the
// user's tokens never reach the page: creating the App is a form to post to GitHub, authorizing is
// an address to go to.

const TARGET = "github";

/** Where GitHub sends the browser back after the user authorized the App (the host's route). */
export const authorizationCallbackPath = "/github/authorization/callback";

/**
 * Whether the host has the plugin. GitHub is one chain and the page learns of it from this one
 * fact: with no `github` in `hello.mounted` there is no settings → Connect, no pull-request section
 * on a task, no card under a pull request or an issue an agent once opened, and no subscription or
 * call aimed at the target. The host was started without it (`--github`, `ETA_GITHUB`).
 */
export function useGitHubMounted(): boolean {
  return useWireState((state) =>
    state.mounted.some(
      (plugin) => plugin.name === TARGET && plugin.error === undefined,
    ),
  );
}

/** How often the status is read again while the App waits for its first installation. */
const INSTALL_POLL_MS = 5000;

/** Ask GitHub where the App is installed; the answer also lands in the target's state. */
function useRefreshGitHub() {
  return useWireMutation<GitHubArgs["refresh"], GitHubResults["refresh"]>(
    TARGET,
    "refresh",
    { timeoutMs: 60_000 },
  );
}

/** The GitHub App's state as the host last published it, and a way to ask GitHub again. */
export function useGitHubStatus(): {
  status: GitHubStatus | undefined;
  /** The host has no GitHub plugin. */
  unavailable: boolean;
  /** The host is asking GitHub. */
  isFetching: boolean;
  refresh: () => void;
} {
  const mounted = useGitHubMounted();
  const open = useWireState((state) => state.status === "open");
  const sections = useTarget(mounted ? TARGET : undefined)?.sections;
  const refresh = useRefreshGitHub();
  const ask = refresh.mutate;
  return {
    status: sections?.state as GitHubStatus | undefined,
    unavailable: open && !mounted,
    isFetching: refresh.isPending,
    refresh: useCallback(() => ask({ fresh: true }), [ask]),
  };
}

/**
 * Keeps the state true to GitHub while the settings page is up. Installing happens on GitHub, so
 * the host is asked again when the page opens and gets focus, and every few seconds while the App
 * waits for its first installation. Mount it once.
 */
export function useKeepGitHubFresh(): void {
  const { status, refresh } = useGitHubStatus();
  const open = useWireState((state) => state.status === "open");
  const connected = status !== undefined && status.state !== "not_connected";
  const waiting = status?.state === "not_installed";
  useEffect(() => {
    if (!open || !connected) return;
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, connected, open]);
  useEffect(() => {
    if (!open || !waiting) return;
    const timer = setInterval(refresh, INSTALL_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, open, waiting]);
}

/**
 * Creating the App: GitHub only takes the manifest as a form the browser posts, after which it
 * sends the browser back to the host.
 */
export function useCreateGitHubApp() {
  const create = useWireMutation<
    GitHubArgs["createApp"],
    GitHubResults["createApp"]
  >(TARGET, "createApp");
  return {
    ...create,
    mutate: (
      input: { name: string; organization?: string | undefined },
      options?: { onError?: (error: Error) => void },
    ) =>
      create.mutate(
        {
          name: input.name,
          ...(input.organization === undefined
            ? {}
            : { organization: input.organization }),
          origin: window.location.origin,
        },
        {
          onSuccess: (form) => {
            const element = document.createElement("form");
            element.method = "post";
            element.action = form.action;
            const field = document.createElement("input");
            field.type = "hidden";
            field.name = "manifest";
            field.value = form.manifest;
            element.append(field);
            document.body.append(element);
            element.submit();
          },
          ...(options?.onError === undefined
            ? {}
            : { onError: options.onError }),
        },
      ),
  };
}

/** The user authorizing the App to act on their behalf, on GitHub. */
export function useAuthorizeGitHub() {
  const authorize = useWireMutation<
    GitHubArgs["authorize"],
    GitHubResults["authorize"]
  >(TARGET, "authorize");
  return {
    ...authorize,
    mutate: (_: undefined, options?: { onError?: (error: Error) => void }) =>
      authorize.mutate(
        { origin: window.location.origin },
        {
          onSuccess: ({ url }) => window.location.assign(url),
          ...(options?.onError === undefined
            ? {}
            : { onError: options.onError }),
        },
      ),
  };
}

export function useUnauthorizeGitHub() {
  return useWireMutation<
    GitHubArgs["unauthorize"],
    GitHubResults["unauthorize"]
  >(TARGET, "unauthorize");
}

/** The client ID and secret of an App created before the host kept them. */
export function useSetGitHubOAuthClient() {
  return useWireMutation<
    GitHubArgs["setOAuthClient"],
    GitHubResults["setOAuthClient"]
  >(TARGET, "setOAuthClient");
}

export function useDisconnectGitHub() {
  return useWireMutation<GitHubArgs["disconnect"], GitHubResults["disconnect"]>(
    TARGET,
    "disconnect",
  );
}

/* ------------------------------------------------------------ pull requests */

const NONE: TaskPullView[] = [];

/** The pull requests delivered for a task. */
export function useTaskPulls(taskId: string): readonly TaskPullView[] {
  const mounted = useGitHubMounted();
  const sections = useTarget(mounted ? TARGET : undefined)?.sections;
  const pulls = sections?.pulls as TaskPullView[] | undefined;
  return pulls === undefined
    ? NONE
    : pulls.filter((pull) => pull.taskId === taskId);
}

/**
 * A pull request's state on GitHub now, read through the host with the App's or the authorizing
 * user's token, never the browser's. It changes on GitHub, so every look at the task reads it
 * again; GitHub computes mergeability in the background, so a pending answer is asked again.
 */
const pullKey = (url: string) => ["github", "pull", url] as const;

export function usePullRequest(url: string) {
  // No plugin, no reading: the query stays off, so nothing is called and nothing spins.
  const mounted = useGitHubMounted();
  return useQuery({
    queryKey: pullKey(url),
    enabled: mounted,
    queryFn: () =>
      getWire().call<GitHubResults["pull"]>(
        TARGET,
        "pull",
        { url },
        { timeoutMs: 60_000 },
      ),
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.merge === "pending" ? 5000 : false,
  });
}

/**
 * Merging a pull request at the head the user saw. Whatever the outcome, the pull request is read
 * again; a lost answer is never retried here.
 */
export function useMergePullRequest() {
  const queryClient = useQueryClient();
  return useMutation<
    GitHubResults["merge"],
    Error,
    { url: string; headSha: string }
  >({
    mutationFn: (input) =>
      getWire().call<GitHubResults["merge"]>(TARGET, "merge", input, {
        timeoutMs: 120_000,
      }),
    onSuccess: (pull, input) =>
      queryClient.setQueryData(pullKey(input.url), pull),
    onSettled: (_pull, _error, input) =>
      queryClient.invalidateQueries({ queryKey: pullKey(input.url) }),
  });
}
