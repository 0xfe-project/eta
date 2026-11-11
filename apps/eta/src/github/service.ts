/**
 * Reaching GitHub through one GitHub App, created by and installed for the user.
 *
 * The App is created from a manifest (the browser posts it to GitHub, GitHub sends a one-time code
 * back) and its credentials stay in the database, sealed. Calls go as the App (a JWT signed with its
 * key) or with an installation token, which carries everything the installation was granted;
 * tokens are cached until close to expiry. Nothing here is per agent: once the user authorized the
 * App, every agent acts on the user's behalf (`user.ts`), otherwise as the App.
 *
 * This is the original forge service (`apps/control-plane/internal/github`) moved into the host:
 * the same rules, the same messages, SQLite for the files it kept on a volume.
 */
import type {
  GitHubCredentials,
  GitHubInstallationView,
  GitHubStatus,
} from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { Endpoints, FetchFn } from "./api";
import type { App, User } from "./store";
import { Buffer } from "node:buffer";
import { createSign, randomBytes } from "node:crypto";
import {
  fromGitHub,
  GITHUB,
  Http,
  reasons,
  segment,
  statusOf,
  WEB_URL,
} from "./api";
import { GithubError, notConnected } from "./error";
import {
  GITHUB_AUTHORIZATION_CALLBACK_PATH,
  GITHUB_MANIFEST_CALLBACK_PATH,
  GITHUB_WEBHOOK_PATH,
} from "./path";
import { GithubStore, installUrl, settingsUrl } from "./store";

const MANIFEST_TTL_MS = 60 * 60 * 1000;
const AUTHORIZATION_TTL_MS = 15 * 60 * 1000;
const TOKEN_MARGIN_MS = 10 * 60 * 1000;
const INSTALLATIONS_TTL_MS = 30 * 1000;

/** GitHub App names are global on GitHub and at most 34 characters. */
const APP_NAME = /^[A-Z0-9][\w .-]{0,33}$/i;
const ACCOUNT = /^[A-Z0-9][A-Z0-9-]{0,38}$/i;

/**
 * Everything GitHub lets an App ask for in repositories, and in an organization it is installed
 * on, at the highest level; the user may grant less, and tokens carry whatever the installation
 * was granted.
 */
const APP_PERMISSIONS: Record<string, string> = {
  actions: "write",
  administration: "write",
  artifact_metadata: "write",
  attestations: "write",
  checks: "write",
  code_quality: "write",
  codespaces: "write",
  contents: "write",
  dependabot_secrets: "write",
  deployments: "write",
  discussions: "write",
  environments: "write",
  issues: "write",
  merge_queues: "write",
  metadata: "read",
  packages: "write",
  pages: "write",
  pull_requests: "write",
  repository_creation: "write",
  repository_custom_properties: "write",
  repository_hooks: "write",
  repository_projects: "admin",
  secret_scanning_alerts: "write",
  secrets: "write",
  security_events: "write",
  statuses: "write",
  vulnerability_alerts: "write",
  workflows: "write",

  members: "write",
  organization_administration: "write",
  organization_announcement_banners: "write",
  organization_custom_org_roles: "write",
  organization_custom_properties: "admin",
  organization_custom_roles: "write",
  organization_events: "read",
  organization_hooks: "write",
  organization_packages: "write",
  organization_personal_access_token_requests: "write",
  organization_personal_access_tokens: "write",
  organization_plan: "read",
  organization_projects: "admin",
  organization_secrets: "write",
  organization_self_hosted_runners: "write",
  organization_user_blocking: "write",
};

/** GitHub's JSON for an installation. */
interface Installation {
  id: number;
  app_id?: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  html_url?: string;
}

/** The longest a user's token is handed out for: whoever holds it asks again by then. */
const USER_TOKEN_TTL_SECONDS = 60 * 60;

/** What the last look at GitHub found, for the wizard. */
type Seen = Pick<GitHubStatus, "state" | "installations" | "error">;

interface CachedToken {
  value: string;
  /** Epoch milliseconds. */
  expires: number;
}

export interface GithubOptions {
  db: Database;
  key: Buffer;
  /** The address the browser reaches the host at, when it is not what the web client sees. */
  publicUrl?: string | undefined;
  /** Where GitHub is; a test points it at a fake. */
  endpoints?: Endpoints;
  fetch?: FetchFn;
  /** The clock, epoch milliseconds. */
  now?: () => number;
  /** Say that the `github` target moved. */
  changed: () => void;
  warn: (message: string) => void;
}

export interface PullRequestOpened {
  url: string;
  number: number;
  created: boolean;
  /** Its author on GitHub: the user who authorized the App, or the App's bot. */
  author: string;
}

/** An origin from what a client or an operator wrote, or nothing when it is no web address. */
function originOf(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;
  try {
    const url = new URL(text);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.host !== ""
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

const base64url = (data: Buffer | string): string =>
  Buffer.from(data).toString("base64url");

const random = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export class Github {
  readonly store: GithubStore;
  readonly http: Http;
  readonly now: () => number;
  readonly #options: GithubOptions;
  readonly #tokens = new Map<number, CachedToken>();
  #installations: { list: Installation[]; at: number } | undefined;
  /** Where the last look at GitHub left the status; the wire's `state` section reads this. */
  #seen: Seen | undefined;
  /** One refresh at a time: a refresh token works once. */
  #userLock: Promise<unknown> = Promise.resolve();

  constructor(options: GithubOptions) {
    this.#options = options;
    this.store = new GithubStore(options.db, options.key);
    this.http = new Http(options.endpoints ?? GITHUB, options.fetch);
    this.now = options.now ?? Date.now;
  }

  /* -------------------------------------------------------------- the App */

  app(): App | null {
    return this.store.app();
  }

  require(): App {
    const app = this.app();
    if (app === null) throw notConnected();
    return app;
  }

  /**
   * The origin the browser reaches the host at: the configured public address when there is one,
   * else what the web client reported (`location.origin`).
   */
  origin(reported: string | undefined): string {
    const origin = originOf(this.#options.publicUrl) ?? originOf(reported);
    if (origin === undefined)
      throw new GithubError(
        "INVALID_ORIGIN",
        400,
        "Cannot determine eta's access URL。Start the host with --public-url。",
      );
    return origin;
  }

  #jwt(app: App): string {
    const key = this.store.privateKey();
    if (key === undefined) throw notConnected();
    const now = Math.floor(this.now() / 1000);
    const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: String(app.id),
      }),
    );
    const signature = createSign("RSA-SHA256")
      .update(`${head}.${claims}`)
      .sign(key);
    return `${head}.${claims}.${base64url(signature)}`;
  }

  /** Wraps errors of calls made as the App: GitHub not knowing the App any more has its own answer. */
  #appCall(error: unknown): GithubError {
    if (statusOf(error) === 401)
      return new GithubError(
        "GITHUB_APP_GONE",
        424,
        "GitHub no longer recognizes this App（it may have been deleted on GitHub）。Disconnect and reconnect。",
      );
    return fromGitHub(error);
  }

  /**
   * Creating the App: validates the user's choices and returns the form the browser posts to
   * GitHub, with a one-time state GitHub hands back to `finishManifest`.
   */
  startManifest(
    nameInput: string,
    organizationInput: string | undefined,
    reportedOrigin: string,
  ): { action: string; manifest: string } {
    const name = nameInput.trim();
    if (!APP_NAME.test(name))
      throw new GithubError(
        "INVALID_NAME",
        400,
        "The App name must be 1 to 34 characters，and may use letters、numbers、spaces、dots、underscores、and hyphens。",
      );
    const organization = organizationInput?.trim() ?? "";
    if (organization !== "" && !ACCOUNT.test(organization))
      throw new GithubError("INVALID_ORGANIZATION", 400, "Invalid organization name。");
    if (this.app() !== null)
      throw new GithubError(
        "GITHUB_ALREADY_CONNECTED",
        409,
        "A GitHub App is already connected。",
      );
    const origin = this.origin(reportedOrigin);
    const state = random(24);
    const path =
      organization === ""
        ? "/settings/apps/new"
        : `/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
    this.store.prunePending("manifest", this.now(), MANIFEST_TTL_MS);
    this.store.addPending(state, "manifest", this.now());
    const manifest = JSON.stringify({
      name,
      url: origin,
      description: "eta's agents use GitHub under this App's identity。",
      // Nothing listens for webhooks; GitHub still wants a URL.
      hook_attributes: { url: origin + GITHUB_WEBHOOK_PATH, active: false },
      redirect_url: origin + GITHUB_MANIFEST_CALLBACK_PATH,
      // Installing also asks the user to authorize the App, so it can open pull requests on their
      // behalf; GitHub then returns to the callback URL instead of a setup URL.
      callback_urls: [origin + GITHUB_AUTHORIZATION_CALLBACK_PATH],
      request_oauth_on_install: true,
      // A private App installs only on the account that owns it; public lets the user install it
      // on their other accounts and organizations.
      public: true,
      default_permissions: APP_PERMISSIONS,
      default_events: [],
    });
    return { action: `${WEB_URL}${path}?state=${state}`, manifest };
  }

  /** GitHub's redirect after the App was created: exchanges the code for the App's credentials. */
  async finishManifest(code: string, state: string): Promise<App> {
    const pending = this.store.takePending(
      state,
      "manifest",
      this.now(),
      MANIFEST_TTL_MS,
    );
    if (pending === undefined)
      throw new GithubError(
        "MANIFEST_EXPIRED",
        400,
        "This creation has expired，please return to eta and start again。",
      );
    let created: {
      id: number;
      slug: string;
      name: string;
      html_url: string;
      owner?: { login?: string; type?: string };
      pem: string;
      client_id?: string;
      client_secret?: string;
    };
    try {
      created = await this.http.api({
        method: "POST",
        path: `/app-manifests/${segment(code)}/conversions`,
      });
    } catch (error) {
      if (statusOf(error) === 0) throw fromGitHub(error);
      throw new GithubError(
        "MANIFEST_FAILED",
        424,
        `GitHub did not return the App credentials（${statusOf(error)}），please recreate it。`,
      );
    }
    const secret = created.client_secret ?? "";
    const app: App = {
      id: created.id,
      slug: created.slug,
      name: created.name,
      htmlUrl: created.html_url,
      owner: created.owner?.login ?? "",
      ownerType: created.owner?.type || "User",
      botId: 0,
      clientId: secret === "" ? null : (created.client_id ?? null),
    };
    this.store.saveApp(app, created.pem, secret, this.now());
    this.#forgetCaches();
    await this.#botId(app);
    this.#options.changed();
    return this.require();
  }

  /** Drops the App's credentials and the user's authorization here; the App on GitHub stays. */
  async forget(): Promise<void> {
    await this.forgetUser();
    this.store.deleteApp();
    this.#forgetCaches();
    this.#options.changed();
  }

  #forgetCaches(): void {
    this.#tokens.clear();
    this.#installations = undefined;
    this.#seen = undefined;
  }

  /** Looks up and remembers the App's bot user, for commits; best effort. */
  async #botId(app: App): Promise<void> {
    if (app.botId !== 0) return;
    try {
      const user = await this.http.api<{ id: number }>({
        path: `/users/${segment(`${app.slug}[bot]`)}`,
      });
      this.store.setBot(user.id);
    } catch {
      // The bot exists once GitHub has seen it act.
    }
  }

  /** The App bot's git author. */
  async identity(): Promise<{ name: string; email: string }> {
    const app = this.require();
    await this.#botId(app);
    const botId = this.require().botId;
    if (botId === 0)
      throw new GithubError(
        "GITHUB_UNAVAILABLE",
        424,
        "Cannot read the App's identity from GitHub right now。",
      );
    const bot = `${app.slug}[bot]`;
    return {
      name: bot,
      email: `${botId}+${bot}@users.noreply.github.com`,
    };
  }

  /* ------------------------------------------------------- installations */

  async #listInstallations(fresh: boolean): Promise<Installation[]> {
    const cached = this.#installations;
    if (
      cached !== undefined &&
      !fresh &&
      this.now() - cached.at < INSTALLATIONS_TTL_MS
    )
      return cached.list;
    const app = this.require();
    let list: Installation[];
    try {
      list = await this.http.api<Installation[]>({
        path: "/app/installations",
        query: { per_page: 100 },
        token: this.#jwt(app),
      });
    } catch (error) {
      throw this.#appCall(error);
    }
    this.#installations = { list, at: this.now() };
    return list;
  }

  async installationFor(owner: string): Promise<Installation> {
    for (const fresh of [false, true]) {
      const list = await this.#listInstallations(fresh);
      const found = list.find(
        (inst) => inst.account?.login?.toLowerCase() === owner.toLowerCase(),
      );
      if (found !== undefined) return found;
    }
    throw new GithubError(
      "GITHUB_NOT_INSTALLED",
      409,
      `eta's GitHub App is not installed on ${owner}。Ask the user to install the App on this account or organization in eta's “Settings → Connections”，and authorize the required repositories。`,
    );
  }

  /** An installation token, for all of the installation's repositories and permissions. */
  async installationToken(id: number): Promise<CachedToken> {
    const cached = this.#tokens.get(id);
    if (cached !== undefined && cached.expires - this.now() > TOKEN_MARGIN_MS)
      return cached;
    const app = this.require();
    let minted: { token: string; expires_at: string };
    try {
      minted = await this.http.api({
        method: "POST",
        path: `/app/installations/${id}/access_tokens`,
        token: this.#jwt(app),
      });
    } catch (error) {
      throw this.#appCall(error);
    }
    const token = {
      value: minted.token,
      expires: Date.parse(minted.expires_at),
    };
    this.#tokens.set(id, token);
    return token;
  }

  /* ------------------------------------------------------ for the machines */

  /**
   * What git and gh are set up with. Every caller acts as the same one: the user who authorized
   * the App, with their user access token (`user` names them), so GitHub lets through what needs
   * a user, such as creating a repository in their account; otherwise the App's installation
   * token, as its bot. The one installation (on the account that owns the App) covers every
   * repository the user granted. The commit author is the App's bot either way, once GitHub knows
   * it.
   */
  async credentials(): Promise<GitHubCredentials> {
    const app = this.require();
    const user = await this.userToken();
    if (user !== null) {
      let expires = Math.floor(this.now() / 1000) + USER_TOKEN_TTL_SECONDS;
      if (user.expiresAt !== 0 && user.expiresAt < expires)
        expires = user.expiresAt;
      return {
        token: user.accessToken,
        expiresAt: expires,
        identity: await this.identity().catch(() => null),
        user: user.login,
      };
    }
    const installation = await this.installationFor(app.owner);
    const token = await this.installationToken(installation.id);
    return {
      token: token.value,
      expiresAt: Math.floor(token.expires / 1000),
      identity: await this.identity().catch(() => null),
    };
  }

  /* ------------------------------------------------------------ the status */

  /** What the wizard shows now, from what is stored and what GitHub last said. */
  snapshot(): GitHubStatus {
    const app = this.app();
    if (app === null)
      return {
        state: "not_connected",
        app: null,
        installations: [],
        error: null,
        user: null,
        oauth: false,
        checked: true,
      };
    const user = this.store.user();
    const seen = this.#seen;
    return {
      state: seen?.state ?? "not_installed",
      app: {
        name: app.name,
        slug: app.slug,
        owner: app.owner,
        ownerType: app.ownerType,
        htmlUrl: app.htmlUrl,
        settingsUrl: settingsUrl(app),
        installUrl: installUrl(app),
      },
      installations: seen?.installations ?? [],
      error: seen?.error ?? null,
      user:
        user === null
          ? null
          : { login: user.login, htmlUrl: `${WEB_URL}/${user.login}` },
      oauth: app.clientId !== null && this.store.clientSecret() !== "",
      checked: seen !== undefined,
    };
  }

  /** Asks GitHub where the App is installed; `fresh` skips the short cache of installations. */
  async status(fresh: boolean): Promise<GitHubStatus> {
    if (this.app() === null) {
      this.#seen = undefined;
      return this.snapshot();
    }
    const installations: GitHubInstallationView[] = [];
    let seen: Seen;
    try {
      for (const inst of await this.#listInstallations(fresh))
        installations.push(await this.#installationView(inst));
      seen = {
        state: installations.length > 0 ? "ready" : "not_installed",
        installations,
        error: null,
      };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      seen = {
        state: "error",
        installations: [],
        error: { code: error.code, message: error.message },
      };
    }
    const before = JSON.stringify(this.#seen);
    this.#seen = seen;
    if (JSON.stringify(seen) !== before) this.#options.changed();
    return this.snapshot();
  }

  async #installationView(inst: Installation): Promise<GitHubInstallationView> {
    const view: GitHubInstallationView = {
      id: inst.id,
      account: inst.account?.login ?? "",
      accountType: inst.account?.type ?? "",
      repositorySelection:
        inst.repository_selection === "all" ? "all" : "selected",
      repositories: [],
      totalRepositories: 0,
      manageUrl: inst.html_url ?? null,
    };
    const token = await this.installationToken(inst.id);
    try {
      const repos = await this.http.api<{
        total_count: number;
        repositories: { full_name: string }[];
      }>({
        path: "/installation/repositories",
        query: { per_page: 100 },
        token: token.value,
      });
      view.totalRepositories = repos.total_count;
      view.repositories = repos.repositories.map((repo) => repo.full_name);
    } catch (error) {
      throw fromGitHub(error);
    }
    return view;
  }

  /* -------------------------------------------------------- pull requests */

  /**
   * Opens a pull request on behalf of the user who authorized the App, or else as the App; `base`
   * defaults to the repository's default branch. An open pull request for `head` is returned
   * instead of failing.
   *
   * GitHub refusing the user's token (revoked: 401, which also forgets it) or the user's access
   * falling short of the App's (403, 404) makes the App open it instead, quietly: the user's
   * authorship is a nicety.
   */
  async openPullRequest(input: {
    repository: string;
    head: string;
    title: string;
    body?: string | undefined;
    base?: string | undefined;
    draft?: boolean | undefined;
  }): Promise<PullRequestOpened> {
    const [owner, name] = parseRepository(input.repository);
    const installation = await this.installationFor(owner);
    const user = await this.userToken();
    if (user !== null) {
      try {
        return await this.#createPull(user.accessToken, owner, name, input);
      } catch (error) {
        switch (statusOf(error)) {
          case 0:
            throw fromGitHub(error);
          case 401:
            await this.dropUser();
            break;
          case 403:
          case 404:
            // The App can, though the user cannot: the App opens it.
            break;
          default:
            throw pullError(error);
        }
      }
    }
    const token = await this.installationToken(installation.id);
    try {
      return await this.#createPull(token.value, owner, name, input);
    } catch (error) {
      throw pullError(error);
    }
  }

  /** Opens the pull request with `token`, or returns the one open for `head`; errors are GitHub's. */
  async #createPull(
    token: string,
    owner: string,
    name: string,
    input: {
      head: string;
      title: string;
      body?: string | undefined;
      base?: string | undefined;
      draft?: boolean | undefined;
    },
  ): Promise<PullRequestOpened> {
    const repo = `/repos/${segment(owner)}/${segment(name)}`;
    let base = input.base ?? "";
    if (base === "") {
      const found = await this.http.api<{ default_branch: string }>({
        path: repo,
        token,
      });
      base = found.default_branch;
    }
    try {
      const pull = await this.http.api<{
        html_url: string;
        number: number;
        user?: { login?: string };
      }>({
        method: "POST",
        path: `${repo}/pulls`,
        token,
        json: {
          title: input.title,
          body: input.body ?? "",
          head: input.head,
          base,
          draft: input.draft ?? false,
        },
      });
      return {
        url: pull.html_url,
        number: pull.number,
        created: true,
        author: pull.user?.login ?? "",
      };
    } catch (error) {
      if (
        statusOf(error) === 422 &&
        reasons(error).includes("already exists")
      ) {
        const branch = input.head.includes(":")
          ? input.head
          : `${owner}:${input.head}`;
        try {
          const open = await this.http.api<
            { html_url: string; number: number; user?: { login?: string } }[]
          >({
            path: `${repo}/pulls`,
            query: { head: branch, state: "open" },
            token,
          });
          const first = open[0];
          if (first !== undefined)
            return {
              url: first.html_url,
              number: first.number,
              created: false,
              author: first.user?.login ?? "",
            };
        } catch {
          // Fall through to the original refusal.
        }
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ user */

  /** Runs `work` once the earlier user-token work is over. */
  #locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#userLock.then(work, work);
    this.#userLock = run.catch(() => undefined);
    return run;
  }

  /**
   * The user with a current token, refreshing it first when it is close to expiry; null when
   * nobody authorized the App or the authorization is not usable now. An authorization GitHub
   * refuses to refresh is forgotten.
   */
  userToken(): Promise<User | null> {
    return this.#locked(async () => {
      const user = this.store.user();
      if (user === null) return null;
      const now = this.now();
      if (user.expiresAt === 0 || user.expiresAt * 1000 - now > TOKEN_MARGIN_MS)
        return user;
      const app = this.app();
      if (app === null) return null;
      if (
        user.refreshToken === "" ||
        (user.refreshExpiresAt !== 0 && now / 1000 >= user.refreshExpiresAt)
      ) {
        this.store.deleteUser();
        this.#options.changed();
        return null;
      }
      let fresh: User;
      try {
        fresh = await this.#exchange({
          client_id: app.clientId ?? "",
          client_secret: this.store.clientSecret(),
          grant_type: "refresh_token",
          refresh_token: user.refreshToken,
        });
      } catch (error) {
        if (
          error instanceof GithubError &&
          error.code === "AUTHORIZATION_FAILED"
        ) {
          this.store.deleteUser();
          this.#options.changed();
        }
        return null;
      }
      fresh.login = user.login;
      fresh.id = user.id;
      this.store.saveUser(fresh, now);
      return fresh;
    });
  }

  /** Forgets the user's authorization (GitHub refused it). */
  async dropUser(): Promise<void> {
    await this.#locked(async () => {
      this.store.deleteUser();
    });
    this.#options.changed();
  }

  /** Posts to GitHub's token endpoint: an authorization code or a refresh token. */
  async #exchange(form: Record<string, string>): Promise<User> {
    let out: {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      refresh_token_expires_in?: number;
      error?: string;
      error_description?: string;
    };
    try {
      out = await this.http.oauth({
        method: "POST",
        path: "/login/oauth/access_token",
        form,
      });
    } catch (error) {
      if (statusOf(error) === 0)
        throw new GithubError("GITHUB_UNREACHABLE", 424, "Cannot reach GitHub right now。");
      throw new GithubError(
        "GITHUB_ERROR",
        424,
        `GitHub returned ${statusOf(error)}。`,
      );
    }
    if ((out.error ?? "") !== "" || (out.access_token ?? "") === "")
      throw new GithubError(
        "AUTHORIZATION_FAILED",
        424,
        `GitHub did not grant authorization（${out.error ?? ""}）：${out.error_description ?? ""}`,
      );
    const now = Math.floor(this.now() / 1000);
    return {
      login: "",
      id: 0,
      accessToken: out.access_token!,
      refreshToken: out.refresh_token ?? "",
      expiresAt: (out.expires_in ?? 0) > 0 ? now + out.expires_in! : 0,
      refreshExpiresAt:
        (out.refresh_token_expires_in ?? 0) > 0
          ? now + out.refresh_token_expires_in!
          : 0,
    };
  }

  /** Saves the client ID and secret of an App created before the host kept them. */
  setOAuthClient(clientIdInput: string, secretInput: string): void {
    this.require();
    const clientId = clientIdInput.trim();
    const secret = secretInput.trim();
    if (clientId === "" || secret === "" || /\s/.test(clientId + secret))
      throw new GithubError(
        "INVALID_CLIENT",
        400,
        "Enter the Client ID and the newly generated client secret from the App settings page。",
      );
    this.store.setClient(clientId, secret);
    this.#options.changed();
  }

  /** Where to send the browser for the user to authorize the App. */
  startAuthorization(reportedOrigin: string): string {
    const app = this.require();
    if (app.clientId === null || this.store.clientSecret() === "")
      throw new GithubError(
        "OAUTH_NOT_CONFIGURED",
        409,
        "eta does not have this App's client secret yet。First add a Callback URL on the App settings page、generate a client secret、and enter it in eta。",
      );
    const origin = this.origin(reportedOrigin);
    const state = random();
    const verifier = random();
    const redirectUri = origin + GITHUB_AUTHORIZATION_CALLBACK_PATH;
    this.store.prunePending("authorization", this.now(), AUTHORIZATION_TTL_MS);
    this.store.addPending(state, "authorization", this.now(), {
      verifier,
      redirectUri,
    });
    const challenge = new Bun.CryptoHasher("sha256")
      .update(verifier)
      .digest("base64url");
    const query = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${this.http.oauthUrl}/login/oauth/authorize?${query.toString()}`;
  }

  /**
   * GitHub's code for the user's token. The code comes back either for an authorization the host
   * started (with its state) or right after an installation (`setupAction`, no state). Either
   * way the user must reach an installation of this App, so nobody else's account ends up
   * connected; and a stateless return, which nothing here can tie to a click of ours, is only
   * taken from the account that owns a personal App.
   */
  async finishAuthorization(
    code: string,
    state: string,
    setupAction: string,
  ): Promise<User> {
    const app = this.require();
    const form: Record<string, string> = {
      client_id: app.clientId ?? "",
      client_secret: this.store.clientSecret(),
      code,
    };
    const expired = () =>
      new GithubError(
        "AUTHORIZATION_EXPIRED",
        400,
        "This authorization has expired，please return to eta to authorize again。",
      );
    if (state !== "") {
      const pending = this.store.takePending(
        state,
        "authorization",
        this.now(),
        AUTHORIZATION_TTL_MS,
      );
      if (pending === undefined) throw expired();
      form.code_verifier = pending.verifier;
      form.redirect_uri = pending.redirectUri;
    } else if (setupAction === "") {
      throw expired();
    }
    if (app.clientId === null || form.client_secret === "")
      throw new GithubError(
        "OAUTH_NOT_CONFIGURED",
        409,
        "eta doesn't have this App's client secret yet, so it can't complete authorization.",
      );
    const user = await this.#exchange(form);
    let me: { login: string; id: number };
    let installations: { installations: Installation[] };
    try {
      me = await this.http.api({ path: "/user", token: user.accessToken });
      installations = await this.http.api({
        path: "/user/installations",
        query: { per_page: 100 },
        token: user.accessToken,
      });
    } catch (error) {
      throw fromGitHub(error);
    }
    user.login = me.login;
    user.id = me.id;
    const reaches = installations.installations.some(
      (inst) => inst.app_id === app.id,
    );
    if (!reaches)
      throw new GithubError(
        "AUTHORIZATION_UNRELATED",
        403,
        `The authorized GitHub account ${user.login} can't reach any installation of this App, so eta didn't save it.`,
      );
    if (
      state === "" &&
      app.ownerType !== "Organization" &&
      user.login.toLowerCase() !== app.owner.toLowerCase()
    )
      throw new GithubError(
        "AUTHORIZATION_UNRELATED",
        403,
        `This authorization came from ${user.login}, not the owner of this App ${app.owner}, so eta didn't save it. Go back to eta's “Settings → Connections” to authorize.`,
      );
    await this.#locked(async () => {
      this.store.saveUser(user, this.now());
    });
    this.#options.changed();
    return user;
  }

  /** Revokes the user's authorization on GitHub (best effort) and here. */
  async forgetUser(): Promise<void> {
    await this.#locked(async () => {
      const user = this.store.user();
      if (user === null) return;
      const app = this.app();
      const secret = this.store.clientSecret();
      if (app?.clientId != null && secret !== "") {
        try {
          await this.http.api({
            method: "DELETE",
            path: `/applications/${segment(app.clientId)}/grant`,
            basic: { user: app.clientId, password: secret },
            json: { access_token: user.accessToken },
          });
        } catch {
          // Best effort: the grant may be gone already.
        }
      }
      this.store.deleteUser();
    });
    this.#options.changed();
  }
}

/** `[owner, name]` from "owner/name" or a GitHub remote URL. */
export function parseRepository(value: string): [string, string] {
  let text = value.trim();
  const ssh = "git@github.com:";
  if (text.startsWith(ssh)) {
    text = text.slice(ssh.length);
  } else if (text.includes("://")) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new GithubError("NOT_GITHUB", 400, `${value} is not a GitHub repository.`);
    }
    if (url.hostname !== "github.com")
      throw new GithubError("NOT_GITHUB", 400, `${value} is not a GitHub repository.`);
    text = url.pathname;
  }
  const trimmed = text.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const cut = trimmed.indexOf("/");
  const owner = cut < 0 ? "" : trimmed.slice(0, cut);
  const name = cut < 0 ? "" : trimmed.slice(cut + 1);
  if (owner === "" || name === "" || name.includes("/"))
    throw new GithubError(
      "INVALID_REPOSITORY",
      400,
      `Can't recognize repository ${value}, write it as owner/name.`,
    );
  return [owner, name];
}

function pullError(error: unknown): GithubError {
  if (statusOf(error) === 0) return fromGitHub(error);
  return new GithubError(
    "PULL_REQUEST_FAILED",
    statusOf(error) >= 500 ? 424 : 400,
    `GitHub refused to create the PR (${statusOf(error)}): ${reasons(error)}`,
  );
}

/** What a test sets to point the App at a fake GitHub and move time by hand. */
export interface GithubTuning {
  endpoints?: Endpoints | undefined;
  fetch?: FetchFn | undefined;
  now?: (() => number) | undefined;
}
