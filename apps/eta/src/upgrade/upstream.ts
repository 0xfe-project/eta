/**
 * Whose releases this host takes, which decides whose code it runs next.
 *
 * In order: `--repo` on the command line, `ETA_RELEASES_URL`, what was saved in the settings, and
 * what the build says. `release.yml` puts its own repository in the build, so a fork that cuts a
 * release gets binaries that follow the fork, with nothing to configure.
 *
 * Each of them is written the same way: `owner/name`, a GitHub address, a GitHub Enterprise API
 * address, or the address of any other server that answers like GitHub's releases API. What it
 * comes to says where a token may go (`releases.ts`). The address ends up in logs and on the page,
 * so one that carries a credential is refused here.
 */
import type { UpgradeUpstreamSource } from "@eta/client-contracts";
import process from "node:process";

declare const ETA_HOST_UPSTREAM: string | undefined;

/** What this build follows when nothing else is said. */
export const BUILT_UPSTREAM: string =
  typeof ETA_HOST_UPSTREAM === "string"
    ? ETA_HOST_UPSTREAM
    : "0xfe-project/eta";

/** Under this key in the `setting` table, as the text given (`inbox/setting.ts`). */
export const UPSTREAM_SETTING = "upgrade.upstream";

const GITHUB_API = "https://api.github.com";
const OWNER = "[a-z\\d](?:[a-z\\d-]*[a-z\\d])?";
const NAME = "[\\w.-]+";
const SHORT = new RegExp(`^(${OWNER})/(${NAME})$`, "i");
const WEB_PATH = new RegExp(`^/(${OWNER})/(${NAME})$`, "i");
const API_PATH = new RegExp(`^/repos/(${OWNER})/(${NAME})$`, "i");
const ENTERPRISE_PATH = new RegExp(`^/api/v3/repos/(${OWNER})/(${NAME})$`, "i");

export interface Upstream {
  /**
   * `github` and `enterprise` are served GitHub's credentials, and `other` never is: it takes an
   * `https` address of the right shape to be either of the first two.
   */
  kind: "github" | "enterprise" | "other";
  /** The repository on the API: where `releases/...` hangs from. */
  api: string;
  /** Everything under this is the API, and may see a token. */
  root: string;
  /** What `gh` calls the server. */
  host: string;
  /** For people, and reads back as the same upstream: `owner/name`, or the address. */
  label: string;
}

/** Text that did not parse may still hold a login or a token, and it is about to be shown. */
const withoutSecrets = (text: string): string =>
  text.replace(/[^/]*@/, "").replace(/[?#].*$/, "");

const notARepository = (text: string): Error =>
  new Error(
    `not a repository: ${withoutSecrets(text)}. Give owner/name, a github.com address, or an API address such as https://<host>/api/v3/repos/<owner>/<name>.`,
  );

function onGitHub(text: string, owner: string, repo: string): Upstream {
  const name = repo.replace(/\.git$/, "");
  if (name === "" || /^\.+$/.test(name)) throw notARepository(text);
  return {
    kind: "github",
    api: `${GITHUB_API}/repos/${owner}/${name}`,
    root: GITHUB_API,
    host: "github.com",
    label: `${owner}/${name}`,
  };
}

/** What a way of naming a repository comes to; throws on one that names nothing. */
export function parseUpstream(given: string): Upstream {
  const text = given.trim();
  const short = SHORT.exec(text);
  if (short !== null)
    return onGitHub(text, short[1] as string, short[2] as string);

  let url: URL;
  try {
    url = new URL(text.startsWith("github.com/") ? `https://${text}` : text);
  } catch {
    throw notARepository(text);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw notARepository(text);
  if (url.username !== "" || url.password !== "")
    throw new Error(
      "an upstream address cannot carry a login. It is shown and logged: use ETA_RELEASES_TOKEN.",
    );
  if (url.search !== "" || url.hash !== "") throw notARepository(text);

  const path = url.pathname.replace(/\/+$/, "");
  const secure = url.protocol === "https:";
  if (secure && (url.host === "github.com" || url.host === "www.github.com")) {
    const web = WEB_PATH.exec(path);
    if (web === null) throw notARepository(text);
    return onGitHub(text, web[1] as string, web[2] as string);
  }
  if (secure && url.host === "api.github.com") {
    const api = API_PATH.exec(path);
    if (api === null) throw notARepository(text);
    return onGitHub(text, api[1] as string, api[2] as string);
  }
  const enterprise = secure ? ENTERPRISE_PATH.exec(path) : null;
  if (enterprise !== null) {
    const api = `https://${url.host}${path}`;
    return {
      kind: "enterprise",
      api,
      root: `https://${url.host}/api/v3`,
      host: url.host,
      label: api,
    };
  }
  // Releases hang from a repository, and a server's root is not one.
  if (path === "") throw notARepository(text);
  const api = `${url.origin}${path}`;
  return {
    kind: "other",
    api,
    root: url.origin,
    host: url.host,
    label: api,
  };
}

/** `parseUpstream`'s label, or what can be shown of something it cannot read. */
export function upstreamLabel(text: string): string {
  try {
    return parseUpstream(text).label;
  } catch {
    return withoutSecrets(text);
  }
}

export interface ChosenUpstream {
  text: string;
  source: UpgradeUpstreamSource | "flag";
}

/** The first that is given. Nothing here reads a setting, so the service and the worker can both. */
export function chooseUpstream(given: {
  flag?: string | undefined;
  saved?: string | undefined;
  env?: NodeJS.ProcessEnv;
}): ChosenUpstream {
  const { flag, saved, env = process.env } = given;
  if (flag !== undefined) return { text: flag, source: "flag" };
  if (env.ETA_RELEASES_URL)
    return { text: env.ETA_RELEASES_URL, source: "env" };
  if (saved !== undefined) return { text: saved, source: "setting" };
  return { text: BUILT_UPSTREAM, source: "build" };
}
