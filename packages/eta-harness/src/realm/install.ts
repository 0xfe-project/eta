/**
 * The checks a bare import goes through before a package lands in the realm:
 * bun's Security Scanner asks OSV for known malware, and `--minimum-release-age`
 * keeps out what was published in the last three days.
 *
 * Every way of not knowing is a refusal. A scanner that throws, cannot be found
 * or cannot reach OSV stops the install; there is no switch to let it through.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";

/**
 * Runs in bun's own scanner process, so it is a string the host writes out: a
 * packaged host has no source tree to point at. Only names and versions leave
 * the machine. Only `MAL-` records stop an install: a plain CVE on an old
 * version is not what this gate is for.
 */
export const OSV_SCANNER = `const OSV = "https://api.osv.dev/v1/querybatch";
const BATCH = 1000;

async function ask(queries) {
  const response = await fetch(OSV, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ queries }),
  });
  if (!response.ok) throw new Error("OSV answered " + response.status);
  const { results } = await response.json();
  if (results?.length !== queries.length) throw new Error("OSV answered short");
  return results;
}

export const scanner = {
  version: "1",
  async scan({ packages }) {
    const unique = [
      ...new Map(packages.map((p) => [p.name + "@" + p.version, p])).values(),
    ];
    const advisories = [];
    for (let at = 0; at < unique.length; at += BATCH) {
      let queries = unique.slice(at, at + BATCH).map((p) => ({
        package: { name: p.name, ecosystem: "npm" },
        version: p.version,
      }));
      // A query with more records than one page holds is asked again for the rest.
      while (queries.length > 0) {
        const results = await ask(queries);
        const next = [];
        results.forEach((result, i) => {
          for (const vuln of result.vulns ?? [])
            if (vuln.id.startsWith("MAL-"))
              advisories.push({
                level: "fatal",
                package: queries[i].package.name,
                url: "https://osv.dev/vulnerability/" + vuln.id,
                description: vuln.id + ": known malware",
              });
          if (result.next_page_token)
            next.push({ ...queries[i], page_token: result.next_page_token });
        });
        queries = next;
      }
    }
    return advisories;
  },
};
`;

const MINIMUM_RELEASE_AGE_SECONDS = 259_200;
const INSTALL_TIMEOUT_MS = 120_000;
/** Older versions ignore the flag and the scanner, then exit 0 having installed anything. */
const MINIMUM_BUN = [1, 3] as const;

/**
 * Passed as `--config`, which takes the place of a project's `bunfig.toml` and
 * wins over the user's. The excludes need saying: a user-level list stays in
 * force unless this file names one of its own, and an empty list does not count.
 */
const guardConfig = (scanner: string): string =>
  `[install]
minimumReleaseAgeExcludes = ["eta:none"]

[install.security]
scanner = ${JSON.stringify(scanner)}
`;

function place(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  // Renamed in: another session may be starting an install that reads this file.
  const next = `${path}.${randomUUID()}`;
  writeFileSync(next, content);
  renameSync(next, path);
}

/**
 * Writes the guard out and returns the config's path. Outside any realm root, so
 * a script's ordinary writes do not land on it, and checked before every install,
 * so an edited copy does not stay.
 */
function writeGuard(): string {
  const dir = join(homedir(), ".eta", "package-guard");
  const scanner = join(dir, "osv-scanner.mjs");
  const config = join(dir, "bunfig.toml");
  mkdirSync(dir, { recursive: true });
  place(scanner, OSV_SCANNER);
  place(config, guardConfig(scanner));
  return config;
}

export interface RegistryPackage {
  name: string;
  /** What goes to `bun add`: the name, with a version if the import pinned one. */
  install: string;
  subpath: string;
}

const REGISTRY_SPECIFIER =
  /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(@[^/:\s]+)?(?:\/(.*))?$/i;

/**
 * A bare import as an npm package, or `undefined` when it is anything else.
 *
 * `bun add` takes more than npm names: `owner/repo` is GitHub, and a URL or a
 * `github:` spec installs with the scanner handed an empty list and no release
 * date to look at. `lodash/fp` is therefore split here and installs `lodash`.
 */
export function registryPackage(
  specifier: string,
): RegistryPackage | undefined {
  const match = REGISTRY_SPECIFIER.exec(specifier);
  if (match === null) return undefined;
  const [, name = "", version = "", subpath = ""] = match;
  return { name, install: `${name}${version}`, subpath };
}

export interface Refusal {
  status: "blocked" | "failed";
  /** One line for the ledger. */
  reason: string;
  /** What the model should do about it. */
  advice: string;
}

const DO_NOT_BYPASS = "Do not install it another way or under another name.";

/** Reads why `bun add` stopped. A wording bun changes falls through to its own error lines. */
export function explainFailure(output: string): Refusal {
  const text = stripVTControlCharacters(output);

  const malware = [
    ...text.matchAll(/FATAL: (\S+)\n(?:\s*via\s+› (.+)\n)?\s*(MAL-[^\s:]+)/g),
  ].map(([, name, via, id]) =>
    via?.includes("›") === true
      ? `${name} (${id}) via ${via}`
      : `${name} (${id})`,
  );
  if (malware.length > 0)
    return {
      status: "blocked",
      reason: `known malware: ${[...new Set(malware)].join(", ")}`,
      advice: `Nothing was installed. ${DO_NOT_BYPASS} Tell the user.`,
    };

  const young =
    /No version matching "([^"]+)" found for specifier "([^"]+)" \(blocked by minimum-release-age/.exec(
      text,
    );
  if (young !== null)
    return {
      status: "blocked",
      reason: `too new: no version of ${young[1]} matching ${young[2]} has been published for 3 days`,
      advice: `Nothing was installed. An import without a version takes the newest release that is old enough; otherwise wait, or tell the user. ${DO_NOT_BYPASS}`,
    };

  if (/security scanner failed/i.test(text)) {
    const cause = /Security scanner failed: (.+)/.exec(text)?.[1];
    return {
      status: "blocked",
      reason: `could not check against OSV (${cause ?? "the scanner did not run"})`,
      advice: `Nothing was installed, and nothing is known against this package; the check itself failed. Try again later, and tell the user if it keeps failing. ${DO_NOT_BYPASS}`,
    };
  }

  const errors = text
    .split("\n")
    .filter((line) => line.startsWith("error:"))
    .map((line) => line.slice("error:".length).trim());
  return {
    status: "failed",
    reason: `bun add failed: ${errors.join("; ") || text.trim().split("\n").at(-1) || "no output"}`,
    advice: "Nothing was installed.",
  };
}

interface Finished {
  code: number | null;
  output: string;
  /** Why the process did not run to an exit code, when it did not. */
  error?: string;
}

function runBun(args: string[], cwd: string): Promise<Finished> {
  return new Promise((done) => {
    const child = spawn("bun", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: INSTALL_TIMEOUT_MS,
    });
    let output = "";
    const collect = (chunk: string): void => {
      output += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", collect);
    child.stderr.setEncoding("utf8").on("data", collect);
    child.on("error", (error) => {
      done({ code: null, output, error: error.message });
    });
    child.on("close", (code, signal) => {
      done({
        code,
        output,
        ...(signal === null ? {} : { error: `stopped by ${signal}` }),
      });
    });
  });
}

/** `bun add` finds the nearest `package.json` above the root, as `npm` does. */
function installDir(root: string): string {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return root;
  }
}

function moduleEntries(modules: string): string[] {
  if (!existsSync(modules)) return [];
  return readdirSync(modules).flatMap((name) =>
    name.startsWith("@") || name === ".bin"
      ? readdirSync(join(modules, name)).map((inner) => join(name, inner))
      : [name],
  );
}

const readIfThere = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, "utf8") : undefined;

const MANIFESTS = ["package.json", "bun.lock"];

/**
 * What the directory looked like, and how to put it back. `installedPath` looks
 * before it installs, so a package left behind by a failed install would be
 * loaded by the next import with no check at all.
 */
function remember(dir: string): () => void {
  const modules = join(dir, "node_modules");
  const entries = new Set(moduleEntries(modules));
  const manifests = MANIFESTS.map(
    (name) => [join(dir, name), readIfThere(join(dir, name))] as const,
  );
  return () => {
    for (const entry of moduleEntries(modules))
      if (!entries.has(entry))
        rmSync(join(modules, entry), { recursive: true, force: true });
    for (const [path, content] of manifests) {
      if (content === undefined) rmSync(path, { force: true });
      else if (readIfThere(path) !== content) writeFileSync(path, content);
    }
  };
}

function bunIsTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return (
    major < MINIMUM_BUN[0] ||
    (major === MINIMUM_BUN[0] && minor < MINIMUM_BUN[1])
  );
}

/** What `bun add` said it put in, to show a fallback to an older version. */
const installedLine = (output: string): string | undefined =>
  /^installed (\S+)/m.exec(stripVTControlCharacters(output))?.[1];

export type InstallResult =
  | { ok: true; installed: string | undefined }
  | ({ ok: false } & Refusal);

/** One `bun add` through the guard; on any failure the directory is put back. */
export async function installPackage(
  install: string,
  root: string,
): Promise<InstallResult> {
  const version = await runBun(["--version"], root);
  if (version.code !== 0)
    return {
      ok: false,
      status: "failed",
      reason: `bun could not run: ${version.error ?? version.output.trim()}`,
      advice: "Nothing was installed. Tell the user.",
    };
  if (bunIsTooOld(version.output.trim()))
    return {
      ok: false,
      status: "blocked",
      reason: `bun ${version.output.trim()} ignores the security checks; 1.3 or newer is needed`,
      advice: `Nothing was installed. Tell the user to upgrade bun. ${DO_NOT_BYPASS}`,
    };

  const restore = remember(installDir(root));
  const added = await runBun(
    [
      "add",
      `--config=${writeGuard()}`,
      `--minimum-release-age=${MINIMUM_RELEASE_AGE_SECONDS}`,
      install,
    ],
    root,
  );
  if (added.code === 0)
    return { ok: true, installed: installedLine(added.output) };

  restore();
  if (added.error !== undefined)
    return {
      ok: false,
      status: "failed",
      reason: `bun add did not finish: ${added.error}`,
      advice: "Nothing was installed.",
    };
  return { ok: false, ...explainFailure(added.output) };
}

const turns = new Map<string, Promise<unknown>>();

/**
 * Installs in one directory run one at a time. A module's imports link together,
 * and two `bun add` in one directory would race on `package.json` and on each
 * other's cleanup.
 */
export function inInstallTurn<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const dir = installDir(root);
  const turn = (turns.get(dir) ?? Promise.resolve()).then(work, work);
  const settled = turn.catch(() => undefined);
  turns.set(dir, settled);
  void settled.then(() => {
    if (turns.get(dir) === settled) turns.delete(dir);
  });
  return turn;
}
