/**
 * A machine's directories, answered on that machine.
 *
 * The primary runs this in the host's process and a daemon in its own: the same code, with the
 * machine's own filesystem and programs, and no shell in between. Nothing here knows projects or
 * what was used lately; that is the host's, which adds it to what comes back.
 *
 * Search is adapted from Paseo (`packages/server/src/utils/directory-suggestions.ts`, commit
 * `b24eab7`, Apache License 2.0; see `packages/client-contracts/src/places/LICENSE`): a walk of
 * the home with limits on depth, results and entries looked at, skipping `node_modules`, `.git`
 * and hidden directories unless the path was typed, with a short cache of what each directory
 * holds, ranked with the shared `scorePathMatch`.
 */
import type {
  MachinePlaceOp,
  MachinePlaceReply,
  MachinePlaceResults,
  PathFlavor,
  PlaceEntry,
  PlaceListing,
  PlaceMatch,
  PlaceRef,
  PlaceResolved,
  PlaceSearchResult,
  RepoChoice,
  ReposResult,
} from "@eta/client-contracts";
import type { FsEntry, PlaceFs, PlaceRunner } from "./system";
import {
  compareMatchScores,
  isOpenablePath,
  scoreMatch,
  scorePathMatch,
} from "@eta/client-contracts";
import { fdir as Fdir } from "fdir";
import { LRUCache } from "lru-cache";
import { clone } from "./clone";
import { pathModule, PathRules } from "./rules";
import {
  classifyNetwork,
  fsFailure,
  nodeFs,
  nodeRunner,
  PlaceError,
} from "./system";

/** More than a person scans; past it the listing says so and a search or a typed path takes over. */
export const MAX_LISTED = 1000;

export const SEARCH_LIMITS = {
  /** Results returned at most, and by default. */
  maxResults: 50,
  defaultResults: 30,
  /** How deep under the home a search walks. */
  maxDepth: 6,
  /** Directories looked at before a search gives up on seeing the rest. */
  maxScanned: 20_000,
  /** How long a search may walk. */
  budgetMs: 4_000,
  /** How long a directory's listing is reused. */
  cacheMs: 8_000,
  cacheEntries: 4_000,
} as const;

/** Never walked into by a search: build output and package stores that hold no projects. */
export const SKIPPED_NAMES = new Set([
  "node_modules",
  ".git",
  "venv",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "target",
  "vendor",
  "coverage",
]);

/** Hidden on Windows without a dot: what Explorer hides in a home and at a drive's root. */
const WINDOWS_HIDDEN = new Set([
  "appdata",
  "application data",
  "local settings",
  "programdata",
  "recovery",
  "system volume information",
  "config.msi",
  "documents and settings",
  "msocache",
  "perflogs",
]);

/** A search's own skips on one system: the macOS `Library` is millions of entries of nobody's code. */
function skippedOn(os: string, name: string): boolean {
  if (os === "darwin") return name === "Library";
  return false;
}

export interface PlacesOptions {
  home: string;
  /** `process.platform` of the machine: its path rules, and what it hides. */
  os: string;
  fs?: PlaceFs;
  run?: PlaceRunner;
  /** The git program clones run; a test hands in a scripted one. */
  git?: string;
  now?: () => number;
  /** How long a check of `git` and `gh` is reused. */
  capabilitiesMs?: number;
}

export class Places {
  readonly rules: PathRules;
  readonly os: string;
  readonly #fs: PlaceFs;
  readonly #run: PlaceRunner;
  readonly #git: string | undefined;
  readonly #now: () => number;
  readonly #capabilitiesMs: number;
  /** What each directory held, for a moment (`lru-cache`, bounded by count and age). */
  readonly #listings: LRUCache<string, FsEntry[]>;
  /** The home's directories as the last walk found them, for the next keystrokes' searches. */
  readonly #walks: LRUCache<string, { dirs: string[]; truncated: boolean }>;
  #capabilities:
    | { at: number; value: Promise<MachinePlaceResults["capabilities"]> }
    | undefined;

  constructor(options: PlacesOptions) {
    this.os = options.os;
    this.rules = new PathRules(
      options.os === "win32" ? "win32" : "posix",
      options.home,
    );
    this.#fs = options.fs ?? nodeFs;
    this.#run = options.run ?? nodeRunner;
    this.#git = options.git;
    this.#now = options.now ?? Date.now;
    this.#listings = new LRUCache<string, FsEntry[]>({
      max: SEARCH_LIMITS.cacheEntries,
      ttl: SEARCH_LIMITS.cacheMs,
      perf: { now: () => this.#now() },
      ttlResolution: 0,
    });
    this.#walks = new LRUCache({
      max: 4,
      ttl: SEARCH_LIMITS.cacheMs,
      perf: { now: () => this.#now() },
      ttlResolution: 0,
    });
    this.#capabilitiesMs = options.capabilitiesMs ?? 30_000;
  }

  get flavor(): PathFlavor {
    return this.rules.flavor;
  }

  ref(path: string): PlaceRef {
    return { path, display: this.rules.display(path) };
  }

  /** A typed path, or a failure saying why it cannot be one here. */
  #resolve(raw: string): string {
    const resolved = this.rules.resolve(raw);
    if (!resolved.ok)
      throw new PlaceError(resolved.failure.code, resolved.failure.detail);
    return resolved.path;
  }

  /* ---------------------------------------------------------------- capabilities */

  async capabilities(): Promise<MachinePlaceResults["capabilities"]> {
    const cached = this.#capabilities;
    if (cached !== undefined && this.#now() - cached.at < this.#capabilitiesMs)
      return await cached.value;
    const value = this.#askCapabilities();
    this.#capabilities = { at: this.#now(), value };
    value.catch(() => {
      if (this.#capabilities?.value === value) this.#capabilities = undefined;
    });
    return await value;
  }

  async #askCapabilities(): Promise<MachinePlaceResults["capabilities"]> {
    const [git, ghVersion] = await Promise.all([
      this.#run("git", ["--version"], { timeoutMs: 10_000 }),
      this.#run("gh", ["--version"], { timeoutMs: 10_000 }),
    ]);
    let gh: MachinePlaceResults["capabilities"]["gh"] = "missing";
    if (ghVersion.code === 0) {
      const status = await this.#run("gh", ["auth", "status"], {
        timeoutMs: 15_000,
      });
      gh = status.code === 0 ? "ready" : "signed_out";
    }
    return {
      flavor: this.flavor,
      home: this.rules.home,
      git: git.code === 0,
      gh,
      mkdir: true,
    };
  }

  /* ---------------------------------------------------------------- resolve */

  async resolve(raw: string): Promise<PlaceResolved> {
    const path = this.#resolve(raw);
    const found = await this.#fs.stat(path);
    return {
      ...this.ref(path),
      exists: found !== undefined,
      directory: found?.directory === true,
    };
  }

  /** A directory that is there, or why not. */
  async directory(raw: string): Promise<string> {
    const path = this.#resolve(raw);
    const found = await this.#fs.stat(path);
    if (found === undefined) throw new PlaceError("not_found");
    if (!found.directory) throw new PlaceError("not_directory");
    return path;
  }

  /* ---------------------------------------------------------------- list */

  #hidden(entry: FsEntry): boolean {
    if (entry.name.startsWith(".")) return true;
    if (this.flavor !== "win32") return false;
    // Junctions (`My Documents` in a home) point somewhere already listed.
    if (entry.kind === "link-directory") return true;
    return (
      entry.name.startsWith("$") || WINDOWS_HIDDEN.has(entry.name.toLowerCase())
    );
  }

  async #entries(path: string, fresh = false): Promise<FsEntry[]> {
    const cached = fresh ? undefined : this.#listings.get(path);
    if (cached !== undefined) return cached;
    const entries = await this.#fs.list(path);
    this.#listings.set(path, entries);
    return entries;
  }

  async #isRepo(path: string): Promise<boolean> {
    return (
      (await this.#fs
        .stat(this.rules.join(path, ".git"))
        .catch(() => undefined)) !== undefined
    );
  }

  async #drives(): Promise<string[]> {
    if (this.flavor !== "win32") return [];
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const found = await Promise.all(
      letters.map(async (letter) => {
        const root = `${letter}:\\`;
        const at = await this.#fs.stat(root).catch(() => undefined);
        return at?.directory === true ? root : undefined;
      }),
    );
    return found.filter((root): root is string => root !== undefined);
  }

  async list(raw?: string): Promise<PlaceListing> {
    const path = await this.directory(raw ?? "~");
    const all = await this.#entries(path, true);
    const directories = all.filter(
      (entry) => entry.kind === "directory" || entry.kind === "link-directory",
    );
    // Visible ones first, so a cap cuts what the list does not show by default.
    directories.sort(
      (a, b) =>
        Number(this.#hidden(a)) - Number(this.#hidden(b)) ||
        byName(a.name, b.name),
    );
    const kept = directories.slice(0, MAX_LISTED);
    const entries: PlaceEntry[] = await Promise.all(
      kept.map(async (entry) => {
        const at = this.rules.join(path, entry.name);
        return {
          ...this.ref(at),
          name: entry.name,
          hidden: this.#hidden(entry),
          git: await this.#isRepo(at),
          projectId: null,
        };
      }),
    );
    entries.sort((a, b) => byName(a.name, b.name));
    const parent = this.rules.parent(path);
    return {
      ...this.ref(path),
      parent: parent === null ? null : this.ref(parent),
      crumbs: this.rules.crumbs(path),
      entries,
      truncated: directories.length > MAX_LISTED,
      drives: await this.#drives(),
    };
  }

  /* ---------------------------------------------------------------- search */

  async search(query: string, limit?: number): Promise<PlaceSearchResult> {
    const max = Math.min(
      Math.max(limit ?? SEARCH_LIMITS.defaultResults, 1),
      SEARCH_LIMITS.maxResults,
    );
    const typed = query.trim();
    if (typed === "") return { query, matches: [], truncated: false };
    if (isOpenablePath(typed, this.flavor))
      return await this.#searchTyped(query, typed, max);
    return await this.#searchHome(query, typed, max);
  }

  /**
   * A typed path: the directory itself when it is one, then what is in the directory it names
   * whose names match the last part. Hidden directories count: the path was typed.
   */
  async #searchTyped(
    query: string,
    typed: string,
    max: number,
  ): Promise<PlaceSearchResult> {
    let resolved: string;
    try {
      resolved = this.#resolve(typed);
    } catch {
      return { query, matches: [], truncated: false };
    }
    const endsInSeparator = /[\\/]$/.test(typed) || typed === "~";
    const exact = await this.#fs.stat(resolved).catch(() => undefined);
    const matches: PlaceMatch[] = [];
    if (exact?.directory === true) matches.push(await this.#match(resolved));
    const parent =
      endsInSeparator && exact?.directory === true
        ? resolved
        : this.rules.parent(resolved);
    const term = endsInSeparator ? "" : this.rules.name(resolved);
    if (parent === null) return { query, matches, truncated: false };
    const entries = await this.#entries(parent).catch(() => [] as FsEntry[]);
    const ranked = entries
      .filter(
        (entry) =>
          entry.kind === "directory" || entry.kind === "link-directory",
      )
      .map((entry) => ({ entry, score: scoreMatch(term, entry.name) }))
      .filter(
        (
          found,
        ): found is {
          entry: FsEntry;
          score: NonNullable<typeof found.score>;
        } =>
          found.score !== null &&
          (term.startsWith(".") || !found.entry.name.startsWith(".")) &&
          this.rules.join(parent, found.entry.name) !== resolved,
      )
      .sort(
        (a, b) =>
          compareMatchScores(a.score, b.score) ||
          byName(a.entry.name, b.entry.name),
      );
    for (const { entry } of ranked) {
      if (matches.length >= max) break;
      matches.push(await this.#match(this.rules.join(parent, entry.name)));
    }
    return { query, matches, truncated: ranked.length + 1 > max };
  }

  async #match(path: string): Promise<PlaceMatch> {
    return {
      ...this.ref(path),
      name: this.rules.name(path),
      git: await this.#isRepo(path),
      projectId: null,
    };
  }

  /** A name: a walk of the home, a level at a time, ranked like Paseo's: the name, then the path. */
  /**
   * The home's directories. The walk is `fdir`'s: directories only, links not followed, no deeper
   * than the limit, no more than the limit, stopped at the time budget; the names a search never
   * goes into are left out before they are read. Kept for a moment: the next keystroke searches
   * the same walk.
   */
  async #walk(): Promise<{ dirs: string[]; truncated: boolean }> {
    const home = this.rules.home;
    const cached = this.#walks.get(home);
    if (cached !== undefined) return cached;
    const budget = AbortSignal.timeout(SEARCH_LIMITS.budgetMs);
    const dirs = await new Fdir({ fs: this.#fs.walker })
      .withPathSeparator(pathModule(this.flavor).sep as "/" | "\\")
      .withBasePath()
      .onlyDirs()
      .withMaxDepth(SEARCH_LIMITS.maxDepth)
      .withMaxFiles(SEARCH_LIMITS.maxScanned)
      .withAbortSignal(budget)
      .exclude(
        (name) =>
          this.#hidden({ name, kind: "directory" }) ||
          SKIPPED_NAMES.has(name) ||
          skippedOn(this.os, name),
      )
      .crawl(home)
      .withPromise();
    const walked = {
      dirs,
      truncated: budget.aborted || dirs.length >= SEARCH_LIMITS.maxScanned,
    };
    this.#walks.set(home, walked);
    return walked;
  }

  async #searchHome(
    query: string,
    typed: string,
    max: number,
  ): Promise<PlaceSearchResult> {
    const p = pathModule(this.flavor);
    const home = this.rules.home;
    const q = typed.replace(/\\/g, "/");
    const { dirs: found, truncated } = await this.#walk();
    const ranked: {
      path: string;
      tier: number;
      depth: number;
      offset: number;
      spread: number;
    }[] = [];
    for (const dir of found) {
      const path = p.resolve(dir);
      const relative = p.relative(home, path);
      if (relative === "" || relative.startsWith("..")) continue;
      const segments = relative.split(p.sep);
      const name = scoreMatch(q, segments.at(-1)!);
      const whole =
        name === null || name.tier > 4
          ? scorePathMatch(q, segments.join("/"))
          : null;
      const score = name !== null && name.tier <= 4 ? name : whole;
      if (score === null) continue;
      ranked.push({
        path,
        // A match in the name beats one that runs across the path.
        tier: score === name ? score.tier : 10 + score.tier,
        depth: segments.length,
        offset: score.offset,
        spread: score.spread ?? 0,
      });
    }
    ranked.sort(
      (a, b) =>
        a.tier - b.tier ||
        a.depth - b.depth ||
        a.offset - b.offset ||
        a.spread - b.spread ||
        byName(a.path, b.path),
    );
    const matches = await Promise.all(
      ranked.slice(0, max).map(async ({ path }) => await this.#match(path)),
    );
    return { query, matches, truncated: truncated || ranked.length > max };
  }

  /* ---------------------------------------------------------------- mkdir */

  async mkdir(parentRaw: string, rawName: string): Promise<PlaceRef> {
    const name = rawName.trim();
    if (!this.rules.validName(name)) throw new PlaceError("invalid");
    const parent = await this.directory(parentRaw);
    const path = this.rules.join(parent, name);
    await this.#fs.mkdir(path);
    this.#listings.delete(parent);
    this.#walks.clear();
    return this.ref(path);
  }

  /* ---------------------------------------------------------------- GitHub */

  async repos(query: string): Promise<ReposResult> {
    const { gh } = await this.capabilities();
    if (gh !== "ready")
      return {
        available: false,
        reason: gh === "missing" ? "gh_missing" : "gh_signed_out",
      };
    const typed = query.trim();
    const fields = "description,updatedAt,url";
    const result =
      typed === ""
        ? await this.#run(
            "gh",
            [
              "repo",
              "list",
              "--limit",
              "30",
              "--json",
              `nameWithOwner,${fields}`,
            ],
            { timeoutMs: 20_000 },
          )
        : await this.#run(
            "gh",
            [
              "search",
              "repos",
              typed,
              "--limit",
              "30",
              "--json",
              `fullName,${fields}`,
            ],
            { timeoutMs: 20_000 },
          );
    if (result.timedOut === true) throw new PlaceError("timeout");
    if (result.code !== 0) {
      if (/auth|login/i.test(result.stderr))
        throw new PlaceError("gh_signed_out");
      throw new PlaceError(
        classifyNetwork(result.stderr) ?? "other",
        result.stderr.trim().slice(0, 500),
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new PlaceError(
        "other",
        "gh answered with something that is not JSON",
      );
    }
    const repos: RepoChoice[] = (Array.isArray(raw) ? raw : []).flatMap(
      (item: unknown) => {
        const repo = item as Record<string, unknown>;
        const name = repo.nameWithOwner ?? repo.fullName;
        if (typeof name !== "string") return [];
        return [
          {
            id: `gh:${name}`,
            nameWithOwner: name,
            // `gh repo clone` reaches it the way the user set gh up, with gh's login.
            cloneUrl: name,
            description:
              typeof repo.description === "string" && repo.description !== ""
                ? repo.description
                : null,
            updatedAt:
              typeof repo.updatedAt === "string" ? repo.updatedAt : null,
          },
        ];
      },
    );
    return { available: true, repos };
  }

  /* ---------------------------------------------------------------- clone */

  async clone(
    op: Extract<MachinePlaceOp, { op: "clone" }>,
    options: {
      signal?: AbortSignal;
      onProgress?: (event: unknown) => void;
    } = {},
  ): Promise<PlaceRef> {
    const target = this.#resolve(op.target);
    const parent = this.rules.parent(target);
    if (parent === null) throw new PlaceError("invalid");
    await this.directory(parent);
    if ((await this.#fs.stat(target)) !== undefined)
      throw new PlaceError("exists");
    const { git, gh } = await this.capabilities();
    if (!git) throw new PlaceError("no_git");
    await clone({
      url: op.url,
      ...(op.protocol === undefined ? {} : { protocol: op.protocol }),
      target,
      cwd: parent,
      useGh: gh === "ready",
      run: this.#run,
      fs: this.#fs,
      ...(this.#git === undefined ? {} : { git: this.#git }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined
        ? {}
        : { onProgress: options.onProgress }),
    });
    this.#listings.delete(parent);
    this.#walks.clear();
    return this.ref(target);
  }

  /* ---------------------------------------------------------------- serving */

  /**
   * Answer one op as the link carries it: a value, or the failure with its code. What is not a
   * `PlaceError` is the machine's own trouble, kept in its words.
   */
  async serve(
    op: MachinePlaceOp,
    options: { signal?: AbortSignal; emit?: (event: unknown) => void } = {},
  ): Promise<MachinePlaceReply> {
    try {
      return { ok: true, value: await this.#do(op, options) };
    } catch (error) {
      return { ok: false, failure: fsFailure(error).failure };
    }
  }

  async #do(
    op: MachinePlaceOp,
    options: { signal?: AbortSignal; emit?: (event: unknown) => void },
  ): Promise<unknown> {
    switch (op.op) {
      case "capabilities":
        return await this.capabilities();
      case "resolve":
        return await this.resolve(op.path);
      case "list":
        return await this.list(op.path);
      case "search":
        return await this.search(op.query, op.limit);
      case "mkdir":
        return await this.mkdir(op.parent, op.name);
      case "repos":
        return await this.repos(op.query);
      case "clone":
        return await this.clone(op, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.emit === undefined ? {} : { onProgress: options.emit }),
        });
      default:
        throw new PlaceError(
          "unsupported",
          `no such place op: ${(op as { op: string }).op}`,
        );
    }
  }
}

/** Whatever the case, the order a person reads; the raw name settles a tie. */
function byName(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
