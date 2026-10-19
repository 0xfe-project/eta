/**
 * The GitHub App service against a fake GitHub: creating the App from a manifest, where it is
 * installed, the tokens it mints and the user's authorization with its refresh, pull requests
 * opened and merged, and issue drafts. These are the behaviours of the original Go forge service's
 * tests (`apps/control-plane/internal/forge`), ported.
 */
import type { GitHubPull } from "@eta/client-contracts";
import type { Database } from "bun:sqlite";
import type { MergeFault } from "./support/github";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Database as Sqlite } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, loadMigrations } from "../src/db";
import { newIssueDraft } from "../src/github/draft";
import { GithubError } from "../src/github/error";
import { mergePull, readPull } from "../src/github/pulls";
import { Github, parseRepository } from "../src/github/service";
import { FakeGitHub, NEW_APP, SEED_PERMISSIONS } from "./support/github";

const ORIGIN = "https://eta.test";
const KEY = randomBytes(32);

let fake: FakeGitHub;
let db: Database;
let now: number;
let github: Github;
let changes: number;
let fetchHook:
  | ((url: string, init?: RequestInit) => Promise<Response>)
  | undefined;

function makeGithub(): Github {
  return new Github({
    db,
    key: KEY,
    publicUrl: ORIGIN,
    endpoints: { api: fake.url, oauth: fake.url },
    fetch: async (url, init) =>
      fetchHook === undefined
        ? await fetch(url, init)
        : await fetchHook(url, init),
    now: () => now,
    changed: () => {
      changes += 1;
    },
    warn: () => undefined,
  });
}

beforeEach(() => {
  fake = new FakeGitHub();
  db = new Sqlite(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db, loadMigrations());
  now = Date.now();
  changes = 0;
  fetchHook = undefined;
  github = makeGithub();
});

afterEach(() => {
  fake.stop();
  db.close();
});

/** Create the App the fake knows by `code`, through the manifest flow. */
async function connect(code: "new-app" | "installed-app") {
  const form = github.startManifest("eta test", undefined, ORIGIN);
  const state = new URL(form.action).searchParams.get("state")!;
  return await github.finishManifest(code, state);
}

/** The user authorizing the App as `login`, through GitHub's redirect and back. */
async function authorize(login: string) {
  const url = github.startAuthorization(ORIGIN);
  const back = new URL(fake.authorizeAs(url, login));
  return await github.finishAuthorization(
    back.searchParams.get("code")!,
    back.searchParams.get("state")!,
    "",
  );
}

async function failure(work: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof work === "function" ? work() : work);
  } catch (error) {
    if (error instanceof GithubError) return error;
    throw error;
  }
  throw new Error("expected a GithubError");
}

describe("connecting the App", () => {
  it("is not connected at first", () => {
    const status = github.snapshot();
    expect(status.state).toBe("not_connected");
    expect(status.app).toBeNull();
    expect(status.installations).toEqual([]);
  });

  it("makes a manifest for a user and for an organization", () => {
    const form = github.startManifest(
      "eta Test",
      undefined,
      `${ORIGIN}/ignored`,
    );
    expect(form.action).toMatch(
      /^https:\/\/github\.com\/settings\/apps\/new\?state=/,
    );
    const manifest = JSON.parse(form.manifest) as Record<string, unknown>;
    expect(manifest.redirect_url).toBe(`${ORIGIN}/github/manifest/callback`);
    expect(manifest.callback_urls).toEqual([
      `${ORIGIN}/github/authorization/callback`,
    ]);
    expect(manifest.request_oauth_on_install).toBe(true);
    expect(manifest.public).toBe(true);
    expect(manifest.setup_url).toBeUndefined();
    expect((manifest.hook_attributes as { active: boolean }).active).toBe(
      false,
    );
    const permissions = manifest.default_permissions as Record<string, string>;
    expect(permissions.contents).toBe("write");
    expect(permissions.issues).toBe("write");
    expect(permissions.workflows).toBe("write");

    const org = github.startManifest("eta Test", "acme", ORIGIN);
    expect(org.action).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/,
    );
  });

  it("refuses what GitHub would", () => {
    const bads: [string, string | undefined, string][] = [
      ["", undefined, ORIGIN],
      ["x".repeat(35), undefined, ORIGIN],
      ["eta", "bad org", ORIGIN],
      ["eta", undefined, "javascript:alert(1)"],
    ];
    for (const [name, organization, origin] of bads) {
      const publicless = new Github({
        db,
        key: KEY,
        endpoints: { api: fake.url, oauth: fake.url },
        changed: () => undefined,
        warn: () => undefined,
      });
      expect(() =>
        publicless.startManifest(name, organization, origin),
      ).toThrow(GithubError);
    }
  });

  it("prefers the configured public address over what the page reports", () => {
    const form = github.startManifest("eta", undefined, "http://evil.test");
    expect(JSON.parse(form.manifest).url).toBe(ORIGIN);
  });

  it("is created but not installed, with its secrets sealed", async () => {
    await connect("new-app");
    const status = github.snapshot();
    expect(status.state).toBe("not_installed");
    expect(status.app?.installUrl).toBe(
      "https://github.com/apps/axp-new/installations/new",
    );
    expect(status.app?.settingsUrl).toBe(
      "https://github.com/settings/apps/axp-new",
    );
    expect(status.oauth).toBe(true);
    expect(status.user).toBeNull();
    // Nothing secret is readable in the rows.
    const row = db
      .query<{ private_key: Uint8Array; client_secret: Uint8Array }, []>(
        "SELECT private_key, client_secret FROM github_app",
      )
      .get()!;
    expect(Buffer.from(row.private_key).toString("latin1")).not.toContain(
      "PRIVATE KEY",
    );
    expect(Buffer.from(row.client_secret).toString("latin1")).not.toContain(
      "secret-axp-new",
    );
    expect(github.store.privateKey()).toBe(fake.privateKey);
    expect(github.store.clientSecret()).toBe("secret-axp-new");
  });

  it("lists where the App is installed", async () => {
    await connect("installed-app");
    const status = await github.status(true);
    expect(status.state).toBe("ready");
    const seen = Object.fromEntries(
      status.installations.map((inst) => [
        inst.account,
        [inst.repositorySelection, inst.repositories],
      ]),
    );
    expect(seen).toEqual({
      akarachen: ["selected", ["akarachen/axp", "akarachen/notes"]],
      acme: ["all", ["acme/web", "acme/api"]],
    });
  });

  it("needs the state it issued, once", async () => {
    const forged = await failure(
      github.finishManifest("installed-app", "forged"),
    );
    expect(forged.code).toBe("MANIFEST_EXPIRED");
    expect(github.snapshot().state).toBe("not_connected");

    const form = github.startManifest("eta", undefined, ORIGIN);
    const state = new URL(form.action).searchParams.get("state")!;
    const stale = await failure(github.finishManifest("stale", state));
    expect(stale.code).toBe("MANIFEST_FAILED");
    // The state is spent whatever happened to the code.
    const again = await failure(github.finishManifest("installed-app", state));
    expect(again.code).toBe("MANIFEST_EXPIRED");
  });

  it("forgets a state after an hour", async () => {
    const form = github.startManifest("eta", undefined, ORIGIN);
    const state = new URL(form.action).searchParams.get("state")!;
    now += 61 * 60 * 1000;
    const late = await failure(github.finishManifest("installed-app", state));
    expect(late.code).toBe("MANIFEST_EXPIRED");
  });

  it("allows one App at a time, and forgetting it", async () => {
    await connect("new-app");
    const again = await failure(() =>
      github.startManifest("eta 2", undefined, ORIGIN),
    );
    expect(again.code).toBe("GITHUB_ALREADY_CONNECTED");
    await github.forget();
    expect(github.snapshot().state).toBe("not_connected");
    expect(changes).toBeGreaterThan(0);
  });

  it("says so when GitHub no longer knows the App", async () => {
    await connect("new-app");
    fake.deleteApp(NEW_APP);
    const status = await github.status(true);
    expect(status.state).toBe("error");
    expect(status.error?.code).toBe("GITHUB_APP_GONE");
  });

  it("reads as not connected when the key does not open", async () => {
    await connect("installed-app");
    const other = new Github({
      db,
      key: randomBytes(32),
      changed: () => undefined,
      warn: () => undefined,
    });
    expect(other.snapshot().state).toBe("not_connected");
  });
});

describe("what is said before GitHub is connected", () => {
  it("points the user at settings", async () => {
    const credentials = await failure(github.credentials());
    expect(credentials.code).toBe("GITHUB_NOT_CONNECTED");
    expect(credentials.message).toContain("设置 → 连接");
    const opened = await failure(
      github.openPullRequest({ repository: "a/b", head: "x", title: "t" }),
    );
    expect(opened.message).toContain("设置 → 连接");
  });

  it("needs the App installed for credentials", async () => {
    await connect("new-app");
    const error = await failure(github.credentials());
    expect(error.code).toBe("GITHUB_NOT_INSTALLED");
  });
});

describe("tokens", () => {
  it("carry everything the installation was granted, and are cached until close to expiry", async () => {
    await connect("installed-app");
    const before = fake.issuedTokens().length;
    const credentials = await github.credentials();
    const minted = fake.issuedTokens().slice(before);
    // The installation on the App's owner.
    expect(minted).toHaveLength(1);
    expect(minted[0]!.installation).toBe(100);
    expect(credentials.token.startsWith("ghs_")).toBe(true);
    expect(credentials.user).toBeUndefined();
    expect(SEED_PERMISSIONS.contents).toBe("write");
    const again = await github.credentials();
    expect(again.token).toBe(credentials.token);
    expect(fake.issuedTokens()).toHaveLength(before + 1);
    // Close to expiry, a new one.
    now += 55 * 60 * 1000;
    const later = await github.credentials();
    expect(later.token).not.toBe(credentials.token);
  });

  it("sign the App's JWT with its key", async () => {
    await connect("installed-app");
    await github.status(true);
    expect(fake.requests).toContain("GET /app/installations");
  });

  it("name the commit author as the App's bot once GitHub knows it", async () => {
    await connect("installed-app");
    const credentials = await github.credentials();
    expect(credentials.identity?.name).toBe("axp-test[bot]");
    expect(credentials.identity?.email).toMatch(
      /^\d+\+axp-test\[bot\]@users\.noreply\.github\.com$/,
    );
  });
});

describe("opening pull requests", () => {
  it("opens one as the App's bot, into the default branch, and returns the open one the second time", async () => {
    await connect("installed-app");
    const credentials = await github.credentials();
    fake.push(credentials.token, "akarachen/axp", "feature");

    const pull = await github.openPullRequest({
      repository: "git@github.com:akarachen/axp.git",
      head: "feature",
      title: "Add feature",
      body: "Why",
    });
    expect(pull).toEqual({
      url: "https://github.com/akarachen/axp/pull/1",
      number: 1,
      created: true,
      author: "axp-test[bot]",
    });

    const again = await github.openPullRequest({
      repository: "akarachen/axp",
      head: "feature",
      title: "x",
    });
    expect(again.created).toBe(false);
    expect(again.url).toContain("/pull/1");

    const same = await failure(
      github.openPullRequest({
        repository: "akarachen/axp",
        head: "main",
        title: "x",
      }),
    );
    expect(same.code).toBe("PULL_REQUEST_FAILED");
    expect(same.message).toContain("GitHub 拒绝创建 PR");
  });

  it("needs the App installed on the repository's owner", async () => {
    await connect("installed-app");
    const error = await failure(
      github.openPullRequest({
        repository: "stranger/repo",
        head: "x",
        title: "t",
      }),
    );
    expect(error.code).toBe("GITHUB_NOT_INSTALLED");
    expect(error.message).toContain("stranger");
  });

  it("recognizes repositories by name, SSH remote or URL, and nothing else", () => {
    expect(parseRepository("a/b")).toEqual(["a", "b"]);
    expect(parseRepository("git@github.com:a/b.git")).toEqual(["a", "b"]);
    expect(parseRepository("https://github.com/a/b.git")).toEqual(["a", "b"]);
    expect(parseRepository(" https://github.com/a/b/ ")).toEqual(["a", "b"]);
    expect(() => parseRepository("https://gitlab.com/a/b")).toThrow(
      /不是 GitHub 仓库/,
    );
    expect(() => parseRepository("a")).toThrow(/owner\/name/);
    expect(() => parseRepository("a/b/c")).toThrow(/owner\/name/);
  });
});

describe("the user's authorization", () => {
  it("makes pull requests the user's, and keeps the token and refresh token sealed", async () => {
    await connect("installed-app");
    const user = await authorize("akarachen");
    expect(user.login).toBe("akarachen");
    expect(github.snapshot().user?.login).toBe("akarachen");
    const row = db
      .query<{ token: Uint8Array }, []>("SELECT token FROM github_user")
      .get()!;
    expect(Buffer.from(row.token).toString("latin1")).not.toContain("ghu_");
    expect(github.store.user()?.refreshToken).toMatch(/^ghr_/);

    const credentials = await github.credentials();
    fake.push(credentials.token, "akarachen/axp", "by-user");
    const pull = await github.openPullRequest({
      repository: "akarachen/axp",
      head: "by-user",
      title: "As the user",
    });
    expect(pull.author).toBe("akarachen");
    expect(pull.created).toBe(true);
  });

  it("sends GitHub the verifier of a PKCE flow it started", async () => {
    await connect("installed-app");
    const url = new URL(github.startAuthorization(ORIGIN));
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/github/authorization/callback`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe("Iv1.axp-test");
    const back = new URL(fake.authorizeAs(url.href, "akarachen"));
    await github.finishAuthorization(
      back.searchParams.get("code")!,
      back.searchParams.get("state")!,
      "",
    );
    const exchange = fake.exchanges.at(-1)!;
    expect(exchange.code_verifier).toBeTruthy();
    expect(exchange.redirect_uri).toBe(
      `${ORIGIN}/github/authorization/callback`,
    );
  });

  it("refreshes an expired token once, replacing both tokens", async () => {
    await connect("installed-app");
    await authorize("akarachen");
    const before = github.store.user()!;
    now += 8 * 3600 * 1000;
    const credentials = await github.credentials();
    const after = github.store.user()!;
    expect(credentials.user).toBe("akarachen");
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    // Two asks at once are one refresh: a refresh token works once.
    now += 8 * 3600 * 1000;
    const refreshes = fake.exchanges.length;
    await Promise.all([github.credentials(), github.credentials()]);
    expect(fake.exchanges.length).toBe(refreshes + 1);
  });

  it("falls back to the bot when GitHub revokes it, and forgets it", async () => {
    await connect("installed-app");
    // The installation token, from before the user authorized the App: it is what pushes.
    const bot = (await github.credentials()).token;
    await authorize("akarachen");
    fake.revoke(github.store.user()!.accessToken);
    // The user token was good as far as eta knew; the pull request finds out: the 401 drops it
    // and the App opens the pull request instead.
    fake.push(bot, "akarachen/axp", "after-revoke");
    const pull = await github.openPullRequest({
      repository: "akarachen/axp",
      head: "after-revoke",
      title: "Revoked",
    });
    expect(pull.author).toBe("axp-test[bot]");
    expect(github.snapshot().user).toBeNull();
    expect(github.store.user()).toBeNull();
  });

  it("is taken right after an installation, without a state, from the App's owner", async () => {
    await connect("installed-app");
    const user = await github.finishAuthorization(
      fake.codeFor("akarachen"),
      "",
      "install",
    );
    expect(user.login).toBe("akarachen");
  });

  it("is not taken without its state, from anyone else, or without the App", async () => {
    await connect("installed-app");
    // Neither the host's state nor an installation.
    const stateless = await failure(
      github.finishAuthorization(fake.codeFor("akarachen"), "", ""),
    );
    expect(stateless.code).toBe("AUTHORIZATION_EXPIRED");
    expect(github.store.user()).toBeNull();
    // A state the host did not make.
    const forged = await failure(
      github.finishAuthorization(fake.codeFor("akarachen"), "forged", ""),
    );
    expect(forged.code).toBe("AUTHORIZATION_EXPIRED");
    // Someone who reaches no installation of the App.
    const stranger = await failure(authorize("stranger"));
    expect(stranger.code).toBe("AUTHORIZATION_UNRELATED");
    expect(github.store.user()).toBeNull();
    // After an installation, another account than the owner's is not believed.
    const other = await failure(
      github.finishAuthorization(fake.codeFor("stranger"), "", "install"),
    );
    expect(other.code).toBe("AUTHORIZATION_UNRELATED");
    expect(github.store.user()).toBeNull();
  });

  it("is spent with its state, and forgotten after fifteen minutes", async () => {
    await connect("installed-app");
    const url = github.startAuthorization(ORIGIN);
    const back = new URL(fake.authorizeAs(url, "akarachen"));
    now += 16 * 60 * 1000;
    const late = await failure(
      github.finishAuthorization(
        back.searchParams.get("code")!,
        back.searchParams.get("state")!,
        "",
      ),
    );
    expect(late.code).toBe("AUTHORIZATION_EXPIRED");
  });

  it("needs the App's client secret, which an older App is given by hand", async () => {
    await connect("installed-app");
    db.query("UPDATE github_app SET client_secret = NULL").run();
    const error = await failure(() => github.startAuthorization(ORIGIN));
    expect(error.code).toBe("OAUTH_NOT_CONFIGURED");
    expect(
      (await failure(() => github.setOAuthClient("Iv1.axp-test", ""))).code,
    ).toBe("INVALID_CLIENT");
    github.setOAuthClient("Iv1.axp-test", "secret-axp-test");
    expect(github.snapshot().oauth).toBe(true);
    expect((await authorize("akarachen")).login).toBe("akarachen");
  });

  it("is revoked on GitHub when taken away, and by disconnecting", async () => {
    await connect("installed-app");
    await authorize("akarachen");
    const access = github.store.user()!.accessToken;
    await github.forgetUser();
    expect(github.store.user()).toBeNull();
    expect(fake.revoked.has(access)).toBe(true);
    await authorize("akarachen");
    await github.forget();
    expect(github.store.user()).toBeNull();
  });

  it("makes every caller act as the user, so what only a user may do works", async () => {
    await connect("installed-app");
    const bot = await github.credentials();
    expect(bot.token.startsWith("ghs_")).toBe(true);
    expect(bot.user).toBeUndefined();
    expect(await createRepository(bot.token)).toBe(403);

    await authorize("akarachen");
    const user = await github.credentials();
    expect(user.user).toBe("akarachen");
    expect(user.token).toBe(github.store.user()!.accessToken);
    // Asked for again within the hour, so revoking in eta takes effect.
    const left = user.expiresAt - Math.floor(now / 1000);
    expect(left).toBeLessThanOrEqual(3600);
    expect(left).toBeGreaterThan(3500);
    // The commit author stays the App's bot.
    expect(user.identity?.name).toBe("axp-test[bot]");
    expect(await createRepository(user.token)).toBe(201);

    await github.forgetUser();
    const after = await github.credentials();
    expect(after.token.startsWith("ghs_")).toBe(true);
    expect(after.user).toBeUndefined();
  });
});

async function createRepository(token: string): Promise<number> {
  const response = await fetch(`${fake.url}/user/repos`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "made-by-an-agent", private: true }),
  });
  return response.status;
}

/* ----------------------------------------------------------- task pulls */

/** Open a pull request on akarachen/notes as the App; its URL and number. */
async function openPull(branch: string, draft = false) {
  const credentials = await github.credentials();
  fake.push(credentials.token, "akarachen/notes", branch);
  const pull = await github.openPullRequest({
    repository: "akarachen/notes",
    head: branch,
    title: `Change ${branch}`,
    draft,
  });
  return pull;
}

async function pullOf(url: string): Promise<GitHubPull> {
  return await readPull(github, url);
}

describe("a pull request's state and merge", () => {
  it("is read, judged, and merged at the head the user saw", async () => {
    await connect("installed-app");
    const { url } = await openPull("merge-me");

    const pull = await pullOf(url);
    expect(pull.state).toBe("open");
    expect(pull.merge).toBe("ready");
    expect(pull.title).toBe("Change merge-me");
    expect(typeof pull.additions).toBe("number");

    // What the user saw is not the head any more: nothing is merged.
    const stale = await failure(
      mergePull(github, url, "0000000000000000000000000000000000000000"),
    );
    expect(stale.code).toBe("STALE_HEAD");
    expect((await pullOf(url)).state).toBe("open");

    const merged = await mergePull(github, url, pull.headSha);
    expect(merged.state).toBe("merged");
    const after = await pullOf(url);
    expect(after.state).toBe("merged");
    expect(after.merge).toBeUndefined();
    const again = await failure(mergePull(github, url, pull.headSha));
    expect(again.code).toBe("ALREADY_MERGED");
  });

  it("is not merged when GitHub says the head moved", async () => {
    await connect("installed-app");
    const { url, number } = await openPull("pushed-again");
    const pull = await pullOf(url);
    fake.failMerge("akarachen/notes", number, "stale");
    const error = await failure(mergePull(github, url, pull.headSha));
    expect(error.code).toBe("STALE_HEAD");
    expect((await pullOf(url)).state).toBe("open");
  });

  it("checks GitHub when the answer to a merge is lost, and does not retry", async () => {
    await connect("installed-app");
    const { url, number } = await openPull("answer-lost");
    const pull = await pullOf(url);
    fake.failMerge("akarachen/notes", number, "lost");
    fetchHook = async (target, init) => {
      const response = await fetch(target, init);
      if (init?.method === "PUT" && target.endsWith("/merge"))
        throw new TypeError("connection reset");
      return response;
    };
    const merged = await mergePull(github, url, pull.headSha);
    expect(merged.state).toBe("merged");
    expect(fake.mergersOf("akarachen/notes", number)).toEqual(["app"]);
  });

  it("reports a merge GitHub failed as unknown, without retrying", async () => {
    await connect("installed-app");
    const { url, number } = await openPull("github-failed");
    const pull = await pullOf(url);
    fake.failMerge("akarachen/notes", number, "failed" satisfies MergeFault);
    const error = await failure(mergePull(github, url, pull.headSha));
    expect(error.code).toBe("MERGE_UNKNOWN");
    expect(error.status).toBe(424);
    expect((await pullOf(url)).state).toBe("open");
    expect(fake.mergersOf("akarachen/notes", number)).toHaveLength(1);
  });

  it("does not merge a draft", async () => {
    await connect("installed-app");
    const { url } = await openPull("draft", true);
    const pull = await pullOf(url);
    expect(pull.state).toBe("draft");
    expect(pull.merge).toBe("blocked");
    expect(pull.reason).toBeTruthy();
    const error = await failure(mergePull(github, url, pull.headSha));
    expect(error.code).toBe("NOT_MERGEABLE");
  });

  it("cannot read what it is not given, or not shown", async () => {
    const notConnected = await failure(
      pullOf("https://github.com/akarachen/notes/pull/1"),
    );
    expect(notConnected.code).toBe("GITHUB_NOT_CONNECTED");
    await connect("installed-app");
    for (const bad of [
      "https://gitlab.com/a/b/pull/1",
      "https://github.com/a/b/issues/1",
      "https://github.com/a/b/pull/x",
    ]) {
      expect((await failure(pullOf(bad))).code).toBe("INVALID_PULL_REQUEST");
    }
    // Not granted to the App, or not there.
    for (const missing of [
      "https://github.com/akarachen/secret/pull/1",
      "https://github.com/akarachen/notes/pull/999",
    ]) {
      expect((await failure(pullOf(missing))).code).toBe(
        "PULL_REQUEST_UNREACHABLE",
      );
    }
    expect(
      (
        await failure(
          mergePull(
            github,
            "https://github.com/akarachen/notes/pull/999",
            "abc",
          ),
        )
      ).status,
    ).toBe(424);
  });

  it("merges as the App though GitHub reports it no permissions", async () => {
    await connect("installed-app");
    fake.setRepoPermissions("akarachen/notes", { pull: true });
    const { url, number } = await openPull("as-the-app");
    const pull = await pullOf(url);
    expect(pull.merge).toBe("ready");
    const stale = await failure(
      mergePull(github, url, "0000000000000000000000000000000000000000"),
    );
    expect(stale.code).toBe("STALE_HEAD");
    const merged = await mergePull(github, url, pull.headSha);
    expect(merged.state).toBe("merged");
    expect(fake.mergersOf("akarachen/notes", number)).toEqual(["app"]);
  });

  it("does not let a user without write access merge", async () => {
    await connect("installed-app");
    await authorize("akarachen");
    fake.setRepoPermissions("akarachen/notes", { pull: true });
    const { url, number } = await openPull("read-only-user");
    const pull = await pullOf(url);
    expect(pull.merge).toBe("blocked");
    expect(pull.reason).toContain("写权限");
    const error = await failure(mergePull(github, url, pull.headSha));
    expect(error.code).toBe("NOT_MERGEABLE");
    expect(fake.mergersOf("akarachen/notes", number)).toEqual([]);
  });

  it("merges as the App after GitHub refused the user's token", async () => {
    await connect("installed-app");
    await authorize("akarachen");
    fake.setRepoPermissions("akarachen/notes", { pull: true });
    const { url, number } = await openPull("revoked-then-merged");
    fake.revoke(github.store.user()!.accessToken);
    const pull = await pullOf(url);
    expect(pull.merge).toBe("ready");
    expect(github.store.user()).toBeNull();
    const merged = await mergePull(github, url, pull.headSha);
    expect(merged.state).toBe("merged");
    expect(fake.mergersOf("akarachen/notes", number)).toEqual(["app"]);
  });

  it("takes GitHub's refusal of the user's merge as the answer, and does not merge as the App instead", async () => {
    await connect("installed-app");
    await authorize("akarachen");
    fake.setRepoPermissions("akarachen/notes", {
      push: true,
      triage: true,
      pull: true,
    });
    const { url, number } = await openPull("user-refused");
    const pull = await pullOf(url);
    expect(pull.merge).toBe("ready");
    fake.failMerge("akarachen/notes", number, "forbidden");
    const error = await failure(mergePull(github, url, pull.headSha));
    expect(error.code).toBe("MERGE_FORBIDDEN");
    expect(error.status).toBe(403);
    expect(fake.mergersOf("akarachen/notes", number)).toEqual(["user"]);
    expect((await pullOf(url)).state).toBe("open");
    expect(github.store.user()).not.toBeNull();
  });
});

describe("issue drafts", () => {
  it("prefill GitHub's new-issue page", () => {
    const body =
      "## 复现\n1. 打开「设置」\n2. 输入 `a & b = c?` #12 100%+1\n\n> 引用";
    const draft = newIssueDraft({
      repository: "git@github.com:akarachen/axp.git",
      title: "  卡片 & 链接 #1  ",
      body,
    });
    const url = new URL(draft.url);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/akarachen/axp/issues/new",
    );
    expect(url.search).not.toContain("+");
    expect(url.searchParams.get("title")).toBe("卡片 & 链接 #1");
    expect(url.searchParams.get("body")).toBe(body);
    expect(draft.body).toBeUndefined();
    expect(draft.repository).toBe("akarachen/axp");
  });

  it("leave a too long body to paste", () => {
    const body = "很长的正文。\n".repeat(1000);
    const draft = newIssueDraft({
      repository: "akarachen/axp",
      title: "长",
      body,
    });
    expect(draft.url.length).toBeLessThanOrEqual(8000);
    expect(new URL(draft.url).searchParams.has("body")).toBe(false);
    expect(draft.body).toBe(body);
  });

  it("refuse what is not a GitHub repository, or an issue GitHub would not take", () => {
    for (const repository of [
      "",
      "axp",
      "a/b/c",
      "https://evil.example/a/b",
      "a b/c",
      "a/b?x=1",
      "a/b#c",
      "../b",
      "a/..",
      "javascript:alert(1)/x",
    ])
      expect(
        () => newIssueDraft({ repository, title: "t" }),
        repository,
      ).toThrow();
    expect(() => newIssueDraft({ repository: "a/b", title: "  " })).toThrow();
    expect(() =>
      newIssueDraft({ repository: "a/b", title: "长".repeat(257) }),
    ).toThrow();
    expect(() =>
      newIssueDraft({ repository: "a/b", title: "t", body: "x".repeat(65537) }),
    ).toThrow();
  });

  it("match the link the original forge made", () => {
    expect(
      newIssueDraft({ repository: "akarachen/axp", title: "Bug", body: "坏了" })
        .url,
    ).toBe(
      "https://github.com/akarachen/axp/issues/new?body=%E5%9D%8F%E4%BA%86&title=Bug",
    );
  });
});
