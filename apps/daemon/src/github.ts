/**
 * git and gh on a machine, logged in as the GitHub App.
 *
 * The primary holds the App (its key, its secrets, the user's authorization) and hands out a
 * token: the user's once they authorized the App, else the App's installation token, with the
 * App's bot as the commit author. The primary's own sessions ask the service in process; a
 * daemon's ask over the link (`github.credentials`). Either way this keeper is what is left on the
 * machine: the token (an hour old at most), written where gh and git look, refreshed before it
 * expires. The App's secrets never get here.
 *
 * What it writes, under one directory (0700, files 0600):
 *
 * - `gh/hosts.yml`: gh's login for github.com (`GH_CONFIG_DIR` points gh at it);
 * - `token`, `login`: what git's credential helper prints;
 * - `git/github.inc`: the commit author (the App's bot), included into git's config.
 *
 * and what it sets, in `env`: the environment of the sessions' shells (`GH_CONFIG_DIR`, and git's
 * `GIT_CONFIG_*` for the credential helper and the include). `env` is one object that the shells
 * read at every command, so connecting GitHub (or disconnecting it) reaches sessions that are
 * already open, with nothing to restart. While GitHub is not connected `env` holds nothing and the
 * machine's own gh and git logins work as they always did.
 */
import type { GitHubCredentials } from "@eta/client-contracts";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Refresh this long before the token expires. */
const MARGIN_SECONDS = 300;
/** Ask again after this long when there was no token to keep. */
const RETRY_SECONDS = 60;

export interface GitHubKeeperOptions {
  /** Where the files go: `<dataDir>/github`. */
  dir: string;
  /**
   * The credentials, from the primary: null when GitHub is not connected, undefined when the
   * primary cannot be asked now (the login on disk stays as it is).
   */
  credentials: () => Promise<GitHubCredentials | null | undefined>;
  /** The clock, epoch milliseconds. */
  now?: () => number;
  warn: (message: string) => void;
}

/** The environment keys the keeper owns. */
const OWNED = [
  "GH_CONFIG_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0",
  "GIT_CONFIG_VALUE_0",
  "GIT_CONFIG_KEY_1",
  "GIT_CONFIG_VALUE_1",
  "GIT_CONFIG_KEY_2",
  "GIT_CONFIG_VALUE_2",
] as const;

export class GitHubKeeper {
  /** The sessions' shells' environment, added to the process's: empty while not connected. */
  readonly env: NodeJS.ProcessEnv = {};
  readonly #options: GitHubKeeperOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<number> | undefined;
  #stopped = false;

  constructor(options: GitHubKeeperOptions) {
    this.#options = options;
  }

  /** Begin keeping the login fresh: now, and again before each token expires. */
  start(): void {
    this.#stopped = false;
    void this.poke();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Look again now (GitHub was connected, authorized or disconnected; the link came up). */
  async poke(): Promise<void> {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let delay = RETRY_SECONDS;
    try {
      delay = await this.refresh();
    } catch (error) {
      this.#options.warn(`[eta] GitHub refresh failed: ${String(error)}`);
    }
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.poke(), delay * 1000);
    this.#timer.unref();
  }

  /** Seconds until the next refresh. One at a time: concurrent callers share the one in flight. */
  refresh(): Promise<number> {
    this.#running ??= this.#refresh().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #refresh(): Promise<number> {
    const now = this.#options.now ?? Date.now;
    const credentials = await this.#options.credentials();
    if (credentials === undefined) return RETRY_SECONDS;
    if (credentials === null) {
      await this.#clear();
      return RETRY_SECONDS;
    }
    const dir = this.#options.dir;
    const identity = credentials.identity;
    const login = credentials.user || identity?.name || "x-access-token";
    await writePrivate(
      join(dir, "gh", "hosts.yml"),
      `github.com:\n    oauth_token: ${credentials.token}\n    user: ${login}\n    git_protocol: https\n`,
    );
    await writePrivate(join(dir, "login"), login);
    if (identity !== null) {
      await writePrivate(
        join(dir, "git", "github.inc"),
        `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`,
      );
    }
    // Last: the token is what says the rest is there.
    await writePrivate(join(dir, "token"), credentials.token);
    this.#set(dir, identity !== null);
    return Math.max(
      RETRY_SECONDS,
      credentials.expiresAt - now() / 1000 - MARGIN_SECONDS,
    );
  }

  #set(dir: string, identity: boolean): void {
    // git runs this for github.com over https and prints what the helper protocol asks for; the
    // empty value first drops the helpers the machine's own config lists.
    const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
    const helper = `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' "$(cat ${quoted}/login)" "$(cat ${quoted}/token)"; }; f`;
    const entries: [string, string][] = [
      ["credential.https://github.com.helper", ""],
      ["credential.https://github.com.helper", helper],
    ];
    if (identity)
      entries.push(["include.path", join(dir, "git", "github.inc")]);
    for (const key of OWNED) delete this.env[key];
    this.env.GH_CONFIG_DIR = join(dir, "gh");
    this.env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([key, value], index) => {
      this.env[`GIT_CONFIG_KEY_${index}`] = key;
      this.env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }

  /** Not connected (or no longer): the machine's own logins are the only ones. */
  async #clear(): Promise<void> {
    for (const key of OWNED) delete this.env[key];
    const dir = this.#options.dir;
    await Promise.all(
      ["gh", "git", "token", "login"].map((name) =>
        rm(join(dir, name), { recursive: true, force: true }),
      ),
    );
  }
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}
