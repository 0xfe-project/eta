import type { KeyObject } from "node:crypto";
/**
 * A fake GitHub, enough of it for the App: manifest conversion, App JWTs (checked against the App's
 * key), installations and their tokens, repositories, branches and pull requests, user
 * authorization with refresh tokens, grants. It is the stateful stand-in the original Go tests got
 * from `emulate`, written for this suite so that no process or network is needed.
 *
 * Where GitHub does something worth testing against, the fake does it on purpose: a second pull
 * request for the same head is refused with 422; an installation token cannot create a repository
 * in a user's account; an App deleted on GitHub gets 401; a revoked user token gets 401; the
 * repository's `permissions` are the user's, all false for an installation token; and a merge can
 * be made to fail the ways GitHub and networks do.
 */
import { Buffer } from "node:buffer";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";

/** Seeded Apps: one created but not installed, one installed on akarachen and acme. */
export const NEW_APP = 77;
const INSTALLED_APP = 78;

const SEED_INSTALLATIONS = [
  {
    id: 100,
    app: INSTALLED_APP,
    account: "akarachen",
    selection: "selected",
    repos: ["axp", "notes"],
  },
  { id: 101, app: INSTALLED_APP, account: "acme", selection: "all", repos: [] },
];

const SEED_REPOS: Record<string, string[]> = {
  akarachen: ["axp", "notes", "secret"],
  acme: ["web", "api"],
};

export const SEED_PERMISSIONS = {
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  workflows: "write",
};

const APPS: Record<number, string> = {
  [NEW_APP]: "axp-new",
  [INSTALLED_APP]: "axp-test",
};

/** The code GitHub would send back to the App a manifest created. */
const MANIFEST_CODES: Record<string, number> = {
  "new-app": NEW_APP,
  "installed-app": INSTALLED_APP,
};

export type MergeFault = "stale" | "lost" | "failed" | "forbidden";

interface PullRow {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  merged: boolean;
  user: string;
  sha: string;
}

const json = (status: number, body: unknown): Response =>
  Response.json(body, { status });

const bad = (message = "Bad credentials"): Response => json(401, { message });

export class FakeGitHub {
  readonly privateKey: string;
  readonly #publicKey: KeyObject;
  readonly #server: ReturnType<typeof Bun.serve>;
  /** Every request, in order: `METHOD /path`. */
  readonly requests: string[] = [];
  /** Installation token → installation id. */
  readonly tokens = new Map<string, number>();
  /** Every installation token ever minted. */
  readonly minted: { installation: number; token: string }[] = [];
  readonly revoked = new Set<string>();
  readonly deletedApps = new Set<number>();
  /** Who called each pull's merge, in order: `app` or `user`. */
  readonly mergers = new Map<string, string[]>();
  readonly #pulls = new Map<string, PullRow[]>();
  readonly #branches = new Set<string>();
  readonly #refresh = new Map<string, string>();
  readonly #userTokens = new Map<string, string>();
  readonly #mergeFaults = new Map<string, MergeFault>();
  readonly #repoPermissions = new Map<string, Record<string, boolean>>();
  /** Codes `/login/oauth/authorize` handed out → the login. */
  readonly #codes = new Map<string, string>();
  readonly #users = new Set(["akarachen", "stranger"]);
  /** What the token endpoint last saw (for tests of the exchange). */
  readonly exchanges: Record<string, string>[] = [];
  #sequence = 0;
  /** How long the last user tokens live, seconds. */
  expiresIn = 28800;

  constructor() {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    this.privateKey = pair.privateKey
      .export({ type: "pkcs1", format: "pem" })
      .toString();
    this.#publicKey = pair.publicKey;
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => this.#handle(request),
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.#server.port}`;
  }

  stop(): void {
    void this.#server.stop(true);
  }

  /* ------------------------------------------------------------- the knobs */

  deleteApp(id: number): void {
    this.deletedApps.add(id);
  }

  revoke(token: string): void {
    this.revoked.add(token);
  }

  /** Make the next merge of a pull request fail the way GitHub or the network does. */
  failMerge(repo: string, number: number, fault: MergeFault): void {
    this.#mergeFaults.set(`${repo}#${number}`, fault);
  }

  mergersOf(repo: string, number: number): string[] {
    return this.mergers.get(`${repo}#${number}`) ?? [];
  }

  /** The repository's permissions as GitHub reports them to the user; an installation sees none. */
  setRepoPermissions(repo: string, perms: Record<string, boolean>): void {
    this.#repoPermissions.set(repo, perms);
  }

  /** The user's access token as it was last issued, by login. */
  userToken(login: string): string | undefined {
    return [...this.#userTokens]
      .reverse()
      .find(([, who]) => who === login)?.[0];
  }

  /** A branch pushed with a token, as `git push` would leave it. */
  push(token: string, repo: string, branch: string): void {
    if (!this.#valid(token)) throw new Error("push: bad credentials");
    this.#branches.add(`${repo}#${branch}`);
  }

  issuedTokens(): { installation: number; token: string }[] {
    return this.minted;
  }

  /* ----------------------------------------------------------------- state */

  #valid(token: string): boolean {
    return (
      !this.revoked.has(token) &&
      (this.tokens.has(token) || this.#userTokens.has(token))
    );
  }

  #app(request: Request): number | undefined {
    const token = bearer(request);
    if (token === undefined) return undefined;
    const [head, claims, signature] = token.split(".");
    if (!head || !claims || !signature) return undefined;
    const verify = createVerify("RSA-SHA256").update(`${head}.${claims}`);
    if (!verify.verify(this.#publicKey, Buffer.from(signature, "base64url")))
      return undefined;
    const payload = JSON.parse(
      Buffer.from(claims, "base64url").toString("utf8"),
    ) as { iss?: string; exp?: number; iat?: number };
    // A test may move the App's clock; the signature is what is checked, and that it has a lifetime.
    if (payload.exp === undefined || payload.iat === undefined)
      return undefined;
    return Number(payload.iss);
  }

  #login(token: string): string | undefined {
    if (this.revoked.has(token)) return undefined;
    return this.#userTokens.get(token);
  }

  #pullsOf(repo: string): PullRow[] {
    let rows = this.#pulls.get(repo);
    if (rows === undefined) {
      rows = [];
      this.#pulls.set(repo, rows);
    }
    return rows;
  }

  #repoExists(repo: string): boolean {
    const [owner, name] = repo.split("/");
    return SEED_REPOS[owner ?? ""]?.includes(name ?? "") ?? false;
  }

  /** Whether an installation token reaches a repository (selected repositories only). */
  #reaches(installation: number, repo: string): boolean {
    const seeded = SEED_INSTALLATIONS.find((inst) => inst.id === installation);
    if (seeded === undefined) return false;
    const [owner, name] = repo.split("/");
    if (seeded.account !== owner) return false;
    return seeded.selection === "all" || seeded.repos.includes(name ?? "");
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    this.requests.push(`${request.method} ${path}`);

    // --- OAuth (github.com) ------------------------------------------------
    if (request.method === "POST" && path === "/login/oauth/access_token")
      return await this.#accessToken(request);
    if (request.method === "GET" && path === "/login/oauth/authorize")
      return this.#authorize(url);

    const token = bearer(request);
    if (token !== undefined && this.revoked.has(token)) return bad();

    // --- manifest ------------------------------------------------------------
    const manifest = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (request.method === "POST" && manifest) {
      const id = MANIFEST_CODES[manifest[1] ?? ""];
      if (id === undefined) return json(404, { message: "Not Found" });
      const slug = APPS[id]!;
      return json(201, {
        id,
        slug,
        name: slug,
        client_id: `Iv1.${slug}`,
        client_secret: `secret-${slug}`,
        html_url: `https://github.com/apps/${slug}`,
        owner: { login: "akarachen", type: "User" },
        pem: this.privateKey,
      });
    }

    // --- the App (JWT) ------------------------------------------------------------
    if (path.startsWith("/app/")) {
      const id = this.#app(request);
      if (id === undefined || this.deletedApps.has(id)) return bad();
      if (request.method === "GET" && path === "/app/installations") {
        return json(
          200,
          SEED_INSTALLATIONS.filter((inst) => inst.app === id).map((inst) => ({
            id: inst.id,
            app_id: id,
            account: { login: inst.account, type: "User" },
            repository_selection: inst.selection,
            html_url: `https://github.com/settings/installations/${inst.id}`,
          })),
        );
      }
      const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (request.method === "POST" && mint) {
        const installation = Number(mint[1]);
        const seeded = SEED_INSTALLATIONS.find(
          (inst) => inst.id === installation && inst.app === id,
        );
        if (seeded === undefined) return json(404, { message: "Not Found" });
        const value = `ghs_${randomBytes(12).toString("hex")}`;
        this.tokens.set(value, installation);
        this.minted.push({ installation, token: value });
        return json(201, {
          token: value,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: SEED_PERMISSIONS,
        });
      }
      return json(404, { message: "Not Found" });
    }

    // --- users -----------------------------------------------------------------------------
    const bot = /^\/users\/(.+)$/.exec(path);
    if (request.method === "GET" && bot) {
      const login = decodeURIComponent(bot[1]!);
      const slug = login.replace(/\[bot\]$/, "");
      if (Object.values(APPS).includes(slug) && login.endsWith("[bot]"))
        return json(200, {
          login,
          id: 4000 + Object.values(APPS).indexOf(slug),
        });
      return json(404, { message: "Not Found" });
    }
    if (request.method === "GET" && path === "/user") {
      const login = token === undefined ? undefined : this.#login(token);
      if (login === undefined) return bad();
      return json(200, { login, id: 1000 + [...this.#users].indexOf(login) });
    }
    if (request.method === "GET" && path === "/user/installations") {
      const login = token === undefined ? undefined : this.#login(token);
      if (login === undefined) return bad();
      return json(200, {
        installations: SEED_INSTALLATIONS.filter(
          (inst) => login === "akarachen" || inst.account === login,
        ).map((inst) => ({ id: inst.id, app_id: inst.app })),
      });
    }
    if (request.method === "POST" && path === "/user/repos") {
      if (token !== undefined && this.tokens.has(token))
        return json(403, { message: "Resource not accessible by integration" });
      const login = token === undefined ? undefined : this.#login(token);
      if (login === undefined) return bad();
      return json(201, { owner: { login } });
    }
    const grant = /^\/applications\/([^/]+)\/grant$/.exec(path);
    if (request.method === "DELETE" && grant) {
      const body = (await request.json()) as { access_token?: string };
      if (body.access_token !== undefined) this.revoked.add(body.access_token);
      return new Response(null, { status: 204 });
    }

    // --- installation and repositories -------------------------------------
    if (path === "/installation/repositories") {
      const installation =
        token === undefined ? undefined : this.tokens.get(token);
      if (installation === undefined) return bad();
      const seeded = SEED_INSTALLATIONS.find(
        (inst) => inst.id === installation,
      )!;
      const names =
        seeded.selection === "all"
          ? (SEED_REPOS[seeded.account] ?? [])
          : seeded.repos;
      return json(200, {
        total_count: names.length,
        repositories: names.map((name) => ({
          full_name: `${seeded.account}/${name}`,
        })),
      });
    }

    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(path);
    if (repoMatch) return await this.#repo(request, url, repoMatch, token);

    return json(404, { message: "Not Found" });
  }

  /* ------------------------------------------------------------ repositories */

  async #repo(
    request: Request,
    url: URL,
    match: RegExpExecArray,
    token: string | undefined,
  ): Promise<Response> {
    const repo = `${match[1]}/${match[2]}`;
    const rest = match[3] ?? "";
    if (token === undefined || !this.#valid(token)) return bad();
    const installation = this.tokens.get(token);
    const viaApp = installation !== undefined;
    if (
      !this.#repoExists(repo) ||
      (viaApp && !this.#reaches(installation, repo))
    )
      return json(404, { message: "Not Found" });
    const login = viaApp ? `${APPS[INSTALLED_APP]}[bot]` : this.#login(token)!;

    if (request.method === "GET" && rest === "") {
      const configured = this.#repoPermissions.get(repo);
      const perms = viaApp ? {} : (configured ?? undefined);
      return json(200, {
        full_name: repo,
        default_branch: "main",
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
        ...(perms === undefined
          ? {
              permissions: {
                admin: true,
                maintain: true,
                push: true,
                triage: true,
                pull: true,
              },
            }
          : {
              permissions: Object.fromEntries(
                ["admin", "maintain", "push", "triage", "pull"].map((level) => [
                  level,
                  perms[level] ?? false,
                ]),
              ),
            }),
      });
    }

    const pulls = this.#pullsOf(repo);
    if (rest === "/pulls" && request.method === "POST") {
      const body = (await request.json()) as {
        title: string;
        body?: string;
        head: string;
        base: string;
        draft?: boolean;
      };
      if (body.head === body.base)
        return json(422, {
          message: "Validation Failed",
          errors: [
            { message: `No commits between ${body.base} and ${body.head}` },
          ],
        });
      if (!this.#branches.has(`${repo}#${body.head}`))
        return json(422, {
          message: "Validation Failed",
          errors: [
            {
              message: `Head sha can't be blank, branch ${body.head} not found`,
            },
          ],
        });
      if (pulls.some((pull) => pull.head === body.head && !pull.merged))
        return json(422, {
          message: "Validation Failed",
          errors: [
            {
              message: `A pull request already exists for ${match[1]}:${body.head}.`,
            },
          ],
        });
      const row: PullRow = {
        number: pulls.length + 1,
        head: body.head,
        base: body.base,
        title: body.title,
        body: body.body ?? "",
        draft: body.draft ?? false,
        merged: false,
        user: login,
        sha: randomBytes(20).toString("hex"),
      };
      pulls.push(row);
      return json(201, this.#pullJson(repo, row));
    }
    if (rest === "/pulls" && request.method === "GET") {
      const head = url.searchParams.get("head");
      return json(
        200,
        pulls
          .filter(
            (pull) =>
              !pull.merged &&
              (head === null || `${match[1]}:${pull.head}` === head),
          )
          .map((pull) => this.#pullJson(repo, pull)),
      );
    }
    const one = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
    if (one) {
      const row = pulls.find((pull) => pull.number === Number(one[1]));
      if (row === undefined) return json(404, { message: "Not Found" });
      if (one[2] === undefined && request.method === "GET")
        return json(200, this.#pullJson(repo, row));
      if (one[2] !== undefined && request.method === "PUT")
        return await this.#merge(request, repo, row, viaApp);
    }
    return json(404, { message: "Not Found" });
  }

  #pullJson(repo: string, row: PullRow): Record<string, unknown> {
    return {
      number: row.number,
      html_url: `https://github.com/${repo}/pull/${row.number}`,
      title: row.title,
      body: row.body,
      state: row.merged ? "closed" : "open",
      draft: row.draft,
      merged: row.merged,
      user: { login: row.user },
      base: { ref: row.base },
      head: { ref: row.head, sha: row.sha },
      additions: 3,
      deletions: 1,
      mergeable: true,
      mergeable_state: "clean",
    };
  }

  async #merge(
    request: Request,
    repo: string,
    row: PullRow,
    viaApp: boolean,
  ): Promise<Response> {
    const key = `${repo}#${row.number}`;
    const fault = this.#mergeFaults.get(key);
    this.#mergeFaults.delete(key);
    this.mergers.set(key, [
      ...(this.mergers.get(key) ?? []),
      viaApp ? "app" : "user",
    ]);
    const body = (await request.json()) as { sha?: string };
    switch (fault) {
      case "forbidden":
        return json(403, { message: "Resource not accessible by integration" });
      case "stale":
        return json(409, {
          message: "Head branch was modified. Review and try the merge again.",
        });
      case "failed":
        return json(502, { message: "Server Error" });
      case "lost":
        // GitHub merges; the answer never arrives (the test's fetch drops it).
        row.merged = true;
        return json(200, { merged: true });
      default:
    }
    if (body.sha !== undefined && body.sha !== row.sha)
      return json(409, {
        message: "Head branch was modified. Review and try the merge again.",
      });
    if (row.merged)
      return json(405, { message: "Pull Request is not mergeable" });
    row.merged = true;
    return json(200, { merged: true, sha: randomBytes(20).toString("hex") });
  }

  /* ------------------------------------------------------------------ OAuth */

  /** `/login/oauth/authorize`: the user (as the `login` query) authorizes; redirect back with a code. */
  #authorize(url: URL): Response {
    const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
    const login = url.searchParams.get("login") ?? "akarachen";
    const code = `code-${++this.#sequence}-${randomBytes(6).toString("hex")}`;
    this.#codes.set(code, login);
    redirect.searchParams.set("code", code);
    const state = url.searchParams.get("state");
    if (state !== null) redirect.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: { location: redirect.href },
    });
  }

  /** Authorizing as a login, the way the browser would: the redirect's address. */
  authorizeAs(authorizeUrl: string, login: string): string {
    const url = new URL(authorizeUrl);
    url.searchParams.set("login", login);
    const response = this.#authorize(url);
    return response.headers.get("location")!;
  }

  /** A code for a login, with no state (what GitHub sends after an installation). */
  codeFor(login: string): string {
    const code = `code-${++this.#sequence}-${randomBytes(6).toString("hex")}`;
    this.#codes.set(code, login);
    return code;
  }

  async #accessToken(request: Request): Promise<Response> {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    this.exchanges.push(form);
    const slug = (form.client_id ?? "").replace(/^Iv1\./, "");
    if (form.client_secret !== `secret-${slug}`)
      return json(200, { error: "incorrect_client_credentials" });
    let login: string | undefined;
    if (form.grant_type === "refresh_token") {
      login = this.#refresh.get(form.refresh_token ?? "");
      this.#refresh.delete(form.refresh_token ?? "");
      if (login === undefined) return json(200, { error: "bad_refresh_token" });
    } else {
      login = this.#codes.get(form.code ?? "");
      this.#codes.delete(form.code ?? "");
      if (login === undefined)
        return json(200, {
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        });
    }
    const access = `ghu_${randomBytes(12).toString("hex")}`;
    const refresh = `ghr_${randomBytes(12).toString("hex")}`;
    this.#userTokens.set(access, login);
    this.#refresh.set(refresh, login);
    return json(200, {
      access_token: access,
      token_type: "bearer",
      expires_in: this.expiresIn,
      refresh_token: refresh,
      refresh_token_expires_in: 15897600,
    });
  }
}

function bearer(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  return header?.replace(/^Bearer\s+/i, "") ?? undefined;
}
