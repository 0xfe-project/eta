/**
 * The `github` target: the GitHub App the user connects, and the pull requests agents opened.
 *
 * Two sections. `state` is the connection as the wizard shows it (the App, the user who
 * authorized it, where it is installed); `pulls` is the pull requests opened for tasks. Secrets
 * (the App's key, its client secret, the user's tokens) never leave the host: the wizard gets
 * addresses to open and a manifest to post.
 */

/** The actions this target has. One list, so the wire and the plugin cannot disagree. */
export const GITHUB_ACTIONS = [
  "refresh",
  "createApp",
  "setOAuthClient",
  "authorize",
  "unauthorize",
  "disconnect",
  "pull",
  "merge",
] as const;
export type GitHubAction = (typeof GITHUB_ACTIONS)[number];

/** `not_connected`: no App; `not_installed`: created, nowhere installed; `error`: GitHub refused. */
export type GitHubConnectionState =
  | "not_connected"
  | "not_installed"
  | "ready"
  | "error";

export interface GitHubAppView {
  name: string;
  slug: string;
  owner: string;
  ownerType: string;
  htmlUrl: string;
  settingsUrl: string;
  installUrl: string;
}

export interface GitHubInstallationView {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  repositories: string[];
  totalRepositories: number;
  manageUrl: string | null;
}

export interface GitHubStatus {
  state: GitHubConnectionState;
  app: GitHubAppView | null;
  installations: GitHubInstallationView[];
  error: { code: string; message: string } | null;
  /** Who authorized the App to act on their behalf. */
  user: { login: string; htmlUrl: string } | null;
  /** Whether the host has the App's client secret, so it can ask for an authorization. */
  oauth: boolean;
  /** False until the host has asked GitHub where the App is installed since it started. */
  checked: boolean;
}

/** A pull request opened for a task (by `open_pull_request` in a conversation linked to it). */
export interface TaskPullView {
  taskId: string;
  url: string;
  title: string;
  number: number;
  openedAt: number;
}

export interface GitHubSections {
  state: GitHubStatus;
  pulls: TaskPullView[];
}

/** A pull request as the task's detail shows it. */
export interface GitHubPull {
  url: string;
  title: string;
  state: "open" | "draft" | "merged" | "closed";
  additions: number;
  deletions: number;
  /** The commit the user sees; merging names it. */
  headSha: string;
  /** Open ones only: whether GitHub would merge it now, and why not. */
  merge?: "ready" | "pending" | "blocked";
  reason?: string;
}

export interface GitHubArgs {
  /** Read GitHub again (where the App is installed); `fresh` skips the short cache. */
  refresh: { fresh?: boolean };
  /**
   * Start creating the App. `origin` is where the browser reaches the host (`location.origin`);
   * the configured public address wins. The reply is a form to post to GitHub.
   */
  createApp: { name: string; organization?: string; origin: string };
  /** The client ID and secret of an App created before the host kept them. */
  setOAuthClient: { clientId: string; clientSecret: string };
  authorize: { origin: string };
  unauthorize: Record<string, never>;
  disconnect: Record<string, never>;
  pull: { url: string };
  merge: { url: string; headSha: string };
}

export interface GitHubResults {
  refresh: GitHubStatus;
  createApp: { action: string; manifest: string };
  setOAuthClient: Record<string, never>;
  authorize: { url: string };
  unauthorize: Record<string, never>;
  disconnect: Record<string, never>;
  pull: GitHubPull;
  merge: GitHubPull;
}

/** Who commits are authored by: the App's bot. */
export interface GitHubIdentity {
  name: string;
  email: string;
}

/**
 * What a machine sets git and gh up with (`github.credentials` over a daemon's link). The token
 * is the user's once they authorized the App, else the App's installation token; the host hands
 * it out for at most an hour, so revoking the authorization takes effect within it.
 */
export interface GitHubCredentials {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
  identity: GitHubIdentity | null;
  /** The user the token is for; absent for the App's. */
  user?: string;
}
