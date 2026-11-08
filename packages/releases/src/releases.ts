/**
 * Where a release comes from: the repository's GitHub Releases, through the REST API. Which
 * repository is `upstream.ts`.
 *
 * The API serves a private repository and a public one the same way, so there is one path and the
 * only difference is a token: `GH_TOKEN`, `GITHUB_TOKEN` (first `GH_ENTERPRISE_TOKEN`, on GitHub
 * Enterprise), one the user saved for that host (the host's `upgrade/token.ts`), or what `gh` is
 * logged in with there. The desktop app, which has no settings of its own, has all but the saved one.
 * Without any it asks anonymously, which is all a public repository needs. Any other server is not
 * given GitHub's credentials: it gets `ETA_RELEASES_TOKEN`, and only that.
 *
 * A token is found again for every `Releases`, and only one the user saved is kept. It is never
 * put in an error: they end up in the status file and on the page. What they say instead is where
 * the token came from, because the user has to tell an absent token from one that cannot read the
 * repository, and from a `gh` that is logged in somewhere this process cannot reach.
 *
 * What is checked here is that a download is whole, against the `SHA256SUMS` of the same release.
 * That says the file is the one that was published, as far as GitHub is believed.
 *
 * The same repository releases the desktop app under `desktop-v*` tags (`release-desktop.yml`).
 * Those are not hosts: a host only ever takes a `v*` tag (`isHostTag`), whatever GitHub calls the
 * latest release.
 */
import type { Upstream } from "./upstream";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { BUILT_UPSTREAM, parseUpstream } from "./upstream";

const run = promisify(execFile);

/** How a token the user saved in the host's settings is named as a source (`ReleaseToken.from`). */
export const SAVED_TOKEN = "Settings";

/** A token the user saved, and the host it may go to, as `gh` would call it. */
export interface SavedToken {
  host: string;
  token: string;
}

const USER_AGENT = "eta-host";
/** How long a request may go without a byte, on a file too big for a limit on the whole. */
const STALL_MS = 60_000;
const API_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const GH_TIMEOUT_MS = 5000;
/** One page of the release list, newest first: a host release further back than this is not the latest. */
const LIST_PAGE = 100;

/** `v0.2.0` or `v0.2.0-rc.1`: what `release.yml` publishes. `desktop-v0.1.0` is the app's. */
const HOST_TAG = /^v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

export const isHostTag = (tag: string): boolean => HOST_TAG.test(tag);

/**
 * Why a release or its file could not be had, for the one who has to do something about it:
 * - `offline`: nothing answered.
 * - `interrupted`: a download stopped partway.
 * - `checksum`: what arrived is not what was published.
 * - `refused`: the server said no; `tokenless` when there was no token to ask with.
 * - `none`: there is no such release or file.
 */
export type ReleaseFailure =
  | "offline"
  | "interrupted"
  | "checksum"
  | "refused"
  | "none";

export class ReleaseError extends Error {
  readonly kind: ReleaseFailure;
  readonly tokenless: boolean;

  constructor(kind: ReleaseFailure, message: string, tokenless = false) {
    super(message);
    this.name = "ReleaseError";
    this.kind = kind;
    this.tokenless = tokenless;
  }
}

export interface ReleaseAsset {
  name: string;
  /** Its address on the API, which answers with the file (or a redirect to it). */
  url: string;
}

export interface Release {
  /** The tag without its `v`. */
  version: string;
  assets: ReleaseAsset[];
}

/** What `gh` had to say when it gave no token. */
type GhTrouble =
  /** It is not on this process's PATH. */
  | "missing"
  /** It has no login for the host. */
  | "logged-out"
  /** It has one and cannot read it: the keychain is out of a service's reach. */
  | "unreadable";

export interface ReleaseToken {
  token?: string;
  /** The name to say it by: an environment variable, `gh`, or `SAVED_TOKEN`. */
  from?: string;
  gh?: GhTrouble;
}

export interface ReleasesOptions {
  /** How the repository was given (`parseUpstream`); what the build says if not. */
  upstream?: string;
  /** What the user saved, if anything; it only counts on its own host. */
  saved?: SavedToken | undefined;
  token?: () => Promise<ReleaseToken>;
  fetch?: typeof fetch;
  /** Whether there is a Settings page to save a token in: the host's, not the desktop app's. */
  settings?: boolean;
}

/** `gh`'s token for `host`, or why it has none. Its own words are not passed on. */
async function askGh(
  host: string,
  env: NodeJS.ProcessEnv,
): Promise<ReleaseToken> {
  const gh = (...args: string[]) =>
    run("gh", args, { env, timeout: GH_TIMEOUT_MS });
  try {
    const token = (await gh("auth", "token", "--hostname", host)).stdout.trim();
    if (token !== "") return { token, from: "gh" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { gh: "missing" };
    // It says the same whether it has no login or cannot read one. Its config knows which.
  }
  const user = await gh("config", "get", "user", "--host", host).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  );
  return { gh: user === "" ? "logged-out" : "unreadable" };
}

/** The token to ask `upstream` with, if there is one. */
export async function releaseToken(
  upstream: Upstream,
  env: NodeJS.ProcessEnv = process.env,
  saved?: SavedToken,
): Promise<ReleaseToken> {
  const names =
    upstream.kind === "other"
      ? ["ETA_RELEASES_TOKEN"]
      : upstream.kind === "enterprise"
        ? ["GH_ENTERPRISE_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_TOKEN", "GITHUB_TOKEN"];
  for (const name of names) {
    const token = env[name];
    if (token) return { token, from: name };
  }
  if (upstream.kind === "other") return {};
  if (saved?.host === upstream.host)
    return { token: saved.token, from: SAVED_TOKEN };
  return await askGh(upstream.host, env);
}

/** `<sha256>  <file>` lines, as `sha256sum` writes them. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match !== null)
      sums.set(match[2] as string, (match[1] as string).toLowerCase());
  }
  return sums;
}

/** A release as the API lists it, as far as this reads it. */
export interface ListedRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  assets: { name: string; url: string }[];
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Published, a host's tag, and not a pre-release. */
const isHostRelease = (release: ListedRelease): boolean =>
  isHostTag(release.tag_name) &&
  release.draft !== true &&
  release.prerelease !== true &&
  !release.tag_name.includes("-");

const describe = (release: ListedRelease): Release => ({
  version: release.tag_name.replace(/^v/, ""),
  assets: release.assets.map(({ name, url }) => ({ name, url })),
});

/** The highest published host release that is not a pre-release, among `releases`. */
export function newestHost<T extends ListedRelease>(
  releases: T[],
): T | undefined {
  return releases
    .filter(isHostRelease)
    .sort((a, b) => Bun.semver.order(a.tag_name.slice(1), b.tag_name.slice(1)))
    .at(-1);
}

export class Releases {
  readonly upstream: Upstream;
  readonly #fetch: typeof fetch;
  readonly #settings: boolean;
  #token: Promise<ReleaseToken>;
  /** The token the server refused, kept to say so and to keep it out of what it answers. */
  #refusedToken: ReleaseToken | undefined;

  constructor(options: ReleasesOptions = {}) {
    this.upstream = parseUpstream(options.upstream ?? BUILT_UPSTREAM);
    this.#fetch = options.fetch ?? fetch;
    this.#settings = options.settings ?? true;
    this.#token = (
      options.token ??
      (() => releaseToken(this.upstream, process.env, options.saved))
    )();
  }

  /**
   * The newest published host release that is not a pre-release. What GitHub calls the latest
   * release is that, unless it is the desktop app's; then it is the highest `v*` among the newest
   * releases.
   */
  async latest(): Promise<Release> {
    const what = "the latest release";
    const answer = await this.#getApi("releases/latest");
    if (answer.ok) {
      const release = (await answer.json()) as ListedRelease;
      if (isHostTag(release.tag_name) && release.draft !== true)
        return describe(release);
    } else if (answer.status !== 404) throw await this.#refused(what, answer);
    // No latest at all, or one that is not a host: either way, the list says.
    const listed = await this.#getApi(`releases?per_page=${LIST_PAGE}`);
    if (!listed.ok) throw await this.#refused(what, listed);
    const newest = newestHost((await listed.json()) as ListedRelease[]);
    if (newest === undefined)
      throw new ReleaseError(
        "none",
        `${what}: not found: ${this.upstream.label} has no host release (a v* tag)`,
      );
    return describe(newest);
  }

  /** The published host releases that are not pre-releases among the newest, highest first. */
  async hosts(): Promise<Release[]> {
    const listed = await this.#getApi(`releases?per_page=${LIST_PAGE}`);
    if (!listed.ok) throw await this.#refused("the releases", listed);
    return ((await listed.json()) as ListedRelease[])
      .filter(isHostRelease)
      .sort((a, b) =>
        Bun.semver.order(b.tag_name.slice(1), a.tag_name.slice(1)),
      )
      .map(describe);
  }

  async byVersion(version: string): Promise<Release> {
    return await this.#release(`releases/tags/v${version}`, `v${version}`);
  }

  async text(asset: ReleaseAsset): Promise<string> {
    const answer = await this.#get(
      asset.url,
      "application/octet-stream",
      AbortSignal.timeout(API_TIMEOUT_MS),
    );
    if (!answer.ok) throw await this.#refused(asset.name, answer);
    return await answer.text();
  }

  /**
   * The asset into `path`, as it arrives; its SHA-256. `onProgress` hears the bytes so far, and the
   * size when the server says it. Whatever stops it partway is `interrupted`.
   */
  async download(
    asset: ReleaseAsset,
    path: string,
    onProgress?: (received: number, total: number | undefined) => void,
  ): Promise<string> {
    const stalled = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = (): void => {
      clearTimeout(timer);
      timer = setTimeout(
        () => stalled.abort(new Error(`${asset.name}: the download stalled`)),
        STALL_MS,
      );
    };
    alive();
    try {
      const answer = await this.#get(
        asset.url,
        "application/octet-stream",
        stalled.signal,
      );
      if (!answer.ok || answer.body === null)
        throw await this.#refused(asset.name, answer);
      const length = Number(answer.headers.get("content-length"));
      const total = Number.isFinite(length) && length > 0 ? length : undefined;
      const hash = createHash("sha256");
      let received = 0;
      try {
        await pipeline([
          Readable.fromWeb(answer.body as never),
          new Transform({
            transform: (chunk: Uint8Array, _encoding, done) => {
              alive();
              hash.update(chunk);
              received += chunk.length;
              onProgress?.(received, total);
              done(null, chunk);
            },
          }),
          createWriteStream(path, { mode: 0o600 }),
        ]);
      } catch (error) {
        throw new ReleaseError(
          "interrupted",
          `${asset.name}: the download stopped after ${String(received)} bytes: ${reason(error)}`,
        );
      }
      // A connection that closes early can end the body without an error.
      if (total !== undefined && received !== total)
        throw new ReleaseError(
          "interrupted",
          `${asset.name}: the download stopped after ${String(received)} of ${String(total)} bytes`,
        );
      return hash.digest("hex");
    } finally {
      clearTimeout(timer);
    }
  }

  async #getApi(path: string): Promise<Response> {
    return await this.#get(
      `${this.upstream.api}/${path}`,
      "application/vnd.github+json",
      AbortSignal.timeout(API_TIMEOUT_MS),
    );
  }

  async #release(path: string, what: string): Promise<Release> {
    const answer = await this.#getApi(path);
    if (!answer.ok) throw await this.#refused(what, answer);
    const release = (await answer.json()) as ListedRelease;
    if (release.draft === true)
      throw new ReleaseError("none", `${what} is not published`);
    return describe(release);
  }

  /**
   * One GET, with the token only on the API itself. A redirect is followed by hand, because the
   * file lives on a signed address elsewhere, which must not see the token and refuses a request
   * that carries one.
   */
  async #get(
    url: string,
    accept: string,
    signal: AbortSignal,
    hops = 0,
  ): Promise<Response> {
    const onApi = new URL(url).href.startsWith(`${this.upstream.root}/`);
    const { token } = onApi ? await this.#token : ({} as ReleaseToken);
    let answer: Response;
    try {
      answer = await this.#fetch(url, {
        headers: {
          accept,
          "user-agent": USER_AGENT,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        redirect: "manual",
        signal,
      });
    } catch (error) {
      throw new ReleaseError(
        "offline",
        `${new URL(url).host} did not answer: ${reason(error)}`,
      );
    }
    // A token gone stale is no reason to fail on a repository anyone may read.
    if (answer.status === 401 && token !== undefined) {
      this.#refusedToken = await this.#token;
      this.#token = Promise.resolve({});
      return await this.#get(url, accept, signal, hops);
    }
    const location = answer.headers.get("location");
    if (answer.status < 300 || answer.status >= 400 || location === null)
      return answer;
    if (hops >= MAX_REDIRECTS) throw new Error(`too many redirects at ${url}`);
    return await this.#get(
      new URL(location, url).href,
      accept,
      signal,
      hops + 1,
    );
  }

  /** What would give this host a token, or the fact that the one it had was refused. */
  #noToken(gh: GhTrouble | undefined): string {
    const save = this.#settings ? " save a token under Settings," : "";
    const { host, kind } = this.upstream;
    const refused = this.#refusedToken?.from;
    if (refused !== undefined)
      return `the token from ${refused} was refused: it has expired or been revoked`;
    if (kind === "other") return "set ETA_RELEASES_TOKEN";
    const hostname = kind === "enterprise" ? ` --hostname ${host}` : "";
    const env = kind === "enterprise" ? "GH_ENTERPRISE_TOKEN" : "GH_TOKEN";
    if (gh === "missing")
      return `gh is not on this process's PATH: install it,${save} or set ${env}`;
    if (gh === "unreadable")
      return `gh has a login for ${host} that this process cannot read, as happens to a service when the login is in a keychain: run \`gh auth login${hostname} --insecure-storage\`, ${save.trim() === "" ? "" : `${save.trim()} `}or set ${env} in the service's environment`;
    return `gh has no login for ${host} here: run \`gh auth login${hostname}\` as this user,${save} or set ${env}`;
  }

  /** Whether the repository itself can be seen with what this has. A guess at worst: it only words an error. */
  async #seesRepository(): Promise<boolean> {
    if (this.upstream.kind === "other") return false;
    return await this.#get(
      this.upstream.api,
      "application/vnd.github+json",
      AbortSignal.timeout(API_TIMEOUT_MS),
    ).then(
      (answer) => answer.ok,
      () => false,
    );
  }

  async #refused(what: string, answer: Response): Promise<ReleaseError> {
    const { token } = await this.#token;
    const message = await this.#refusal(what, answer);
    return new ReleaseError(
      "refused",
      message,
      token === undefined && this.upstream.kind !== "other",
    );
  }

  async #refusal(what: string, answer: Response): Promise<string> {
    const { from, gh, token } = await this.#token;
    const { kind, label } = this.upstream;
    if (answer.status === 404) {
      if (await this.#seesRepository())
        return `${what}: not found: ${label} has no such release`;
      if (token === undefined)
        return kind === "other" && this.#refusedToken === undefined
          ? `${what}: not found (if this server wants a token: set ETA_RELEASES_TOKEN)`
          : `${what}: not found: ${label} does not exist or is private, and there is no token to read it with: ${this.#noToken(gh)}`;
      return kind === "other"
        ? `${what}: not found`
        : `${what}: not found: ${label} does not exist, or the token from ${from} cannot read it`;
    }
    let detail = await answer.text().catch(() => "");
    for (const spent of [token, this.#refusedToken?.token])
      if (spent !== undefined) detail = detail.replaceAll(spent, "[token]");
    let why = "";
    if ([401, 403, 429].includes(answer.status)) {
      if (token === undefined)
        why =
          kind === "other"
            ? ` (${this.#noToken(gh)})`
            : ` (GitHub limits requests without a token: ${this.#noToken(gh)})`;
      else if (kind !== "other")
        why = ` (the token from ${from} is not allowed to read this, or has hit a limit)`;
    }
    return `${what}: the server answered ${answer.status}${why}${
      detail === "" ? "" : `: ${detail.slice(0, 200)}`
    }`;
  }
}
