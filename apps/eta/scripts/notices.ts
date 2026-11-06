/**
 * The notices a compiled host carries: `THIRD_PARTY_NOTICES.md` from the root of the repository, then
 * every npm package the build can reach with its license texts. `apps/desktop/scripts/stage-host.ts`
 * writes the result next to the page, so the one file brings them along and a running host serves
 * them at `/THIRD_PARTY_NOTICES.md`.
 *
 * The list is made at build time, from what is installed, so it is never out of step with the
 * lockfile and a platform's optional packages show up only in that platform's build.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** What goes into a compiled host. The phone app is built apart, and devDependencies are not in it. */
const SHIPPED = ["apps/eta", "apps/daemon", "apps/web", "apps/desktop"];

/** A package's own legal files. `THIRD-PARTY-NOTICES.md` is where a prebuilt binary names its source. */
const LEGAL_FILE = /^(?:licen[cs]e|copying|notice|third-party-notices)/i;

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/** One third-party package in the build. */
export interface Notice {
  name: string;
  version: string;
  license: string;
  /** Its legal files as `[file name, text]`, in name order. */
  texts: [string, string][];
}

const readPackage = (dir: string): PackageJson =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;

/** Node's lookup, from `from` up to `root`: the real directory, because bun's install links. */
function resolvePackage(
  from: string,
  name: string,
  root: string,
): string | undefined {
  for (let dir = from; dir.startsWith(root); dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json")))
      return realpathSync(candidate);
    if (dir === root) break;
  }
  return undefined;
}

/** What a package needs at run time. A peer it can do without is its user's to install. */
function needs(pkg: PackageJson): string[] {
  const required = Object.keys(pkg.peerDependencies ?? {}).filter(
    (name) => pkg.peerDependenciesMeta?.[name]?.optional !== true,
  );
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...required,
  ];
}

const licenseOf = (pkg: PackageJson): string =>
  (typeof pkg.license === "object" ? pkg.license.type : pkg.license) ??
  "not stated";

function textsIn(dir: string): [string, string][] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LEGAL_FILE.test(entry.name))
    .map((entry): [string, string] => [
      entry.name,
      readFileSync(join(dir, entry.name), "utf8").trim(),
    ])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Every package outside the workspace that `workspaces` reach, by name and version. */
export function thirdPartyPackages(
  root: string,
  workspaces: readonly string[] = SHIPPED,
): Notice[] {
  const real = realpathSync(root);
  const seen = new Set<string>();
  const notices: Notice[] = [];
  const stack = workspaces.map((workspace) => join(real, workspace));
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    const pkg = readPackage(dir);
    for (const name of needs(pkg)) {
      const found = resolvePackage(dir, name, real);
      if (found !== undefined) stack.push(found);
    }
    if (dir.split(sep).includes("node_modules")) {
      notices.push({
        name: pkg.name ?? basename(dir),
        version: pkg.version ?? "unknown",
        license: licenseOf(pkg),
        texts: textsIn(dir),
      });
    }
  }
  return notices.sort((a, b) =>
    a.name === b.name
      ? a.version < b.version
        ? -1
        : 1
      : a.name < b.name
        ? -1
        : 1,
  );
}

/** A fence longer than any run of backticks in `text`, so a license cannot close it. */
function fenced(text: string): string {
  const longest = Math.max(
    2,
    ...[...text.matchAll(/`+/g)].map(([run]) => run.length),
  );
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function section(notice: Notice): string {
  const head = `### ${notice.name} ${notice.version}\n\nLicense: ${notice.license}`;
  const texts = notice.texts.map(
    ([file, text]) => `${file}:\n\n${fenced(text)}`,
  );
  return [head, ...texts].join("\n\n");
}

/** The whole file: the written notices, then the packages of this build. */
export function thirdPartyNotices(root: string): string {
  const written = readFileSync(
    join(root, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  ).trim();
  const packages = thirdPartyPackages(root);
  const list = packages.map(section).join("\n\n");
  return `${written}\n\n## npm packages in this build\n\n${packages.length} packages.\n\n${list}\n`;
}
