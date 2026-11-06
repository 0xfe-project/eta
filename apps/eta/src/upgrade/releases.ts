/**
 * Where a release comes from: the repository's GitHub Releases, through the REST API.
 *
 * The API serves a private repository and a public one the same way, so there is one path and the
 * only difference is a token: `GH_TOKEN`, `GITHUB_TOKEN`, or what `gh` is logged in with. Without
 * any it asks anonymously, which is all a public repository needs. `ETA_RELEASES_URL` points it at
 * another repository (a fork) or at a test's fake; `gh`'s own login is only for GitHub.
 *
 * What is checked here is that a download is whole, against the `SHA256SUMS` of the same release.
 * That says the file is the one that was published, as far as GitHub is believed.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import process from "node:process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

const GITHUB_RELEASES = "https://api.github.com/repos/0xfe-project/eta";

const USER_AGENT = "eta-host";
/** How long a request may go without a byte, on a file too big for a limit on the whole. */
const STALL_MS = 60_000;
const API_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

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

export interface ReleasesOptions {
  url?: string;
  token?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

/** The token to ask with, if there is one. */
export async function releaseToken(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const given = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (given) return given;
  if (url !== GITHUB_RELEASES) return undefined;
  try {
    const { stdout } = await run(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 5000 },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
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

export class Releases {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #token: Promise<string | undefined>;

  constructor(options: ReleasesOptions = {}) {
    this.#url = (options.url ?? GITHUB_RELEASES).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#token = (options.token ?? (() => releaseToken(this.#url)))();
  }

  /** The newest published release that is not a pre-release: what the API means by latest. */
  async latest(): Promise<Release> {
    return await this.#release("releases/latest", "the latest release");
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

  /** The asset into `path`, as it arrives; its SHA-256. */
  async download(asset: ReleaseAsset, path: string): Promise<string> {
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
      const hash = createHash("sha256");
      await pipeline([
        Readable.fromWeb(answer.body as never),
        new Transform({
          transform: (chunk: Uint8Array, _encoding, done) => {
            alive();
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        createWriteStream(path, { mode: 0o600 }),
      ]);
      return hash.digest("hex");
    } finally {
      clearTimeout(timer);
    }
  }

  async #release(path: string, what: string): Promise<Release> {
    const answer = await this.#get(
      `${this.#url}/${path}`,
      "application/vnd.github+json",
      AbortSignal.timeout(API_TIMEOUT_MS),
    );
    if (!answer.ok) throw await this.#refused(what, answer);
    const release = (await answer.json()) as {
      tag_name: string;
      draft?: boolean;
      assets: { name: string; url: string }[];
    };
    if (release.draft === true) throw new Error(`${what} is not published`);
    return {
      version: release.tag_name.replace(/^v/, ""),
      assets: release.assets.map(({ name, url }) => ({ name, url })),
    };
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
    const onApi = new URL(url).origin === new URL(this.#url).origin;
    const token = onApi ? await this.#token : undefined;
    const answer = await this.#fetch(url, {
      headers: {
        accept,
        "user-agent": USER_AGENT,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      redirect: "manual",
      signal,
    });
    // A token gone stale is no reason to fail on a repository anyone may read.
    if (answer.status === 401 && token !== undefined) {
      this.#token = Promise.resolve(undefined);
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

  async #refused(what: string, answer: Response): Promise<Error> {
    const anonymous = (await this.#token) === undefined;
    if (answer.status === 404)
      return new Error(
        anonymous
          ? `${what}: not found (a private repository needs a token: set GH_TOKEN or \`gh auth login\`)`
          : `${what}: not found`,
      );
    const detail = await answer.text().catch(() => "");
    return new Error(
      `${what}: the server answered ${answer.status}${
        anonymous && (answer.status === 403 || answer.status === 429)
          ? " (GitHub limits requests without a token: set GH_TOKEN or `gh auth login`)"
          : ""
      }${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
    );
  }
}
