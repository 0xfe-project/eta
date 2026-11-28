/**
 * Built-in Local File & Directory Watch `TriggerProvider` (`provider = "file-watch"`).
 *
 * - Zero new dependencies: uses `node:fs` (`watch`) with automatic degradation to periodic stat
 *   scanning (`pollingIntervalMinutes`) so Windows recursive watch limitations or watcher errors
 *   never drop file changes.
 * - Cross-platform path validation & `~` expansion via `@eta/places` (`PathRules`), refusing empty
 *   paths and drive/filesystem roots (`/` or `C:\`), always ignoring `.git` directories, and
 *   enforcing a per-instance watched file cap (`maxFiles`, default 5,000).
 * - Debounced (`debounceMs`, default 500 ms) metadata-only (`lstat`) diffing without reading file
 *   contents, producing deterministic `eventId` hashes for `TriggerHub` deduplication.
 */
import type {
  RoutineTrigger,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { Dirent, FSWatcher, Stats, WatchOptions } from "node:fs";
import type { SettingStore } from "../settings/store";
import type {
  TriggerProvider,
  TriggerProviderHost,
  TriggerProvisionResult,
} from "./triggers";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { watch as nodeWatch } from "node:fs";
import { lstat as nodeLstat, readdir as nodeReaddir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import process from "node:process";
import { flavorOf, PathRules } from "@eta/places";
import pLimit from "p-limit";

const FILE_WATCH_PROVIDER_ID = "file-watch";
const FILE_WATCH_SOURCE_SLUG = "fs";
const FILE_WATCH_SOURCE_NAME = "Local Filesystem";
const FILE_WATCH_TRIGGER_SLUG = "FILE_CHANGED";

const DEFAULT_POLL_MINUTES = 5;
const MIN_POLL_MINUTES = 1;
const MAX_POLL_MINUTES = 7 * 24 * 60;
const DEFAULT_DEBOUNCE_MS = 500;
const MIN_DEBOUNCE_MS = 0;
const MAX_DEBOUNCE_MS = 60_000;
const DEFAULT_MAX_FILES = 5_000;
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_ENTRIES_FLOOR = 20_000;
const MAX_SLEEP_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 6 * 60 * 60_000;
const SCAN_CONCURRENCY = 4;
const SETTING_KEY_PREFIX = "file-watch.trigger.";

type FileWatchChangeType = "created" | "modified" | "deleted";

export interface FileWatchEventPayload {
  watchPath: string;
  relativePath: string;
  changeType: FileWatchChangeType;
  mtime: number | null;
  mtimeIso: string | null;
  size: number | null;
}

export type FileWatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

export type FileWatchFn = (
  filename: string,
  options: WatchOptions,
  listener: FileWatchListener,
) => FSWatcher;

export interface FileWatchFs {
  lstat: (
    path: string,
  ) => Promise<
    Pick<
      Stats,
      "isFile" | "isDirectory" | "isSymbolicLink" | "mtimeMs" | "size"
    >
  >;
  readdir: (
    path: string,
    options: { withFileTypes: true },
  ) => Promise<
    Pick<Dirent, "name" | "isFile" | "isDirectory" | "isSymbolicLink">[]
  >;
}

export interface FileWatchTriggerProviderOptions {
  settings: SettingStore;
  now?: (() => number) | undefined;
  timer?: boolean | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  maxFiles?: number | undefined;
  watch?: FileWatchFn | false | undefined;
  fs?: FileWatchFs | undefined;
  backoffBaseMs?: number | undefined;
  backoffMaxMs?: number | undefined;
  warn?: ((message: string) => void) | undefined;
}

export interface FileWatchPollSnapshot {
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  watcherActive: boolean;
  watchedCount: number;
}

interface ParsedFileWatchConfig {
  path: string;
  glob: string | null;
  ignore: string | null;
  includePatterns: CompiledGlob[];
  ignorePatterns: CompiledGlob[];
  debounceMs: number;
  pollingIntervalMinutes: number;
  persistedConfig: Record<string, unknown>;
  fingerprint: string;
}

interface FileSnapshotEntry {
  mtimeMs: number;
  size: number;
}

interface PersistedFileWatchState {
  configFingerprint: string;
  path: string;
  seeded: boolean;
  snapshot: Record<string, FileSnapshotEntry>;
  lastScannedAt: number;
  watchedCount: number;
}

interface ArmedRoutine {
  routineId: string;
  instanceId: string;
  key: string;
  config: ParsedFileWatchConfig;
  intervalMs: number;
  nextPollAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  generation: number;
  watcher: FSWatcher | undefined;
  watcherActive: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  rescanPending: boolean;
  watchedCount: number;
}

interface CompiledGlob {
  raw: string;
  hasSlash: boolean;
  fullRegex: RegExp;
  segmentRegex: RegExp | null;
  prefixRegex: RegExp | null;
}

const DEFAULT_FS: FileWatchFs = {
  lstat: (path) => nodeLstat(path),
  readdir: (path, options) => nodeReaddir(path, options),
};

const FILE_WATCH_CATALOG_ITEM: TriggerCatalogItem = {
  provider: FILE_WATCH_PROVIDER_ID,
  source: FILE_WATCH_SOURCE_SLUG,
  sourceName: FILE_WATCH_SOURCE_NAME,
  trigger: FILE_WATCH_TRIGGER_SLUG,
  name: "File or directory changed",
  description:
    "Watches a local file or directory (with fs.watch and periodic stat fallback) and triggers on created, modified, or deleted files.",
  modes: ["poll"],
  configSchema: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        title: "Watch path",
        description:
          "Absolute path or ~/... path to a local file or directory on this machine.",
        examples: ["~/Documents/reports"],
      },
      glob: {
        type: "string",
        title: "Include glob",
        description:
          "Optional glob pattern(s) relative to the watched directory (comma-separated, e.g. **/*.md, *.txt).",
        examples: ["**/*.md, *.txt"],
      },
      ignore: {
        type: "string",
        title: "Ignore glob",
        description:
          "Optional glob pattern(s) to exclude (comma-separated; .git is always ignored).",
        examples: ["node_modules/**, *.tmp"],
      },
      debounceMs: {
        type: "integer",
        title: "Debounce (ms)",
        description:
          "Quiet window in milliseconds to merge rapid changes into a single event (0–60000).",
        minimum: MIN_DEBOUNCE_MS,
        maximum: MAX_DEBOUNCE_MS,
        default: DEFAULT_DEBOUNCE_MS,
      },
    },
  },
  payloadSchema: {
    type: "object",
    properties: {
      watchPath: { type: "string" },
      relativePath: { type: "string" },
      changeType: { type: "string", enum: ["created", "modified", "deleted"] },
      mtime: { type: ["number", "null"] },
      mtimeIso: { type: ["string", "null"] },
      size: { type: ["integer", "null"] },
    },
  },
  accounts: [],
};

export class FileWatchTriggerProvider implements TriggerProvider {
  readonly id = FILE_WATCH_PROVIDER_ID;

  readonly #settings: SettingStore;
  readonly #now: () => number;
  readonly #timed: boolean;
  readonly #home: string;
  readonly #platform: NodeJS.Platform;
  readonly #maxFiles: number;
  readonly #watchOption: FileWatchFn | false | undefined;
  readonly #fs: FileWatchFs;
  readonly #backoffBaseMs: number | undefined;
  readonly #backoffMaxMs: number | undefined;
  readonly #warn: (message: string) => void;
  readonly #scanLimit = pLimit(SCAN_CONCURRENCY);

  #host: TriggerProviderHost | undefined;
  #started = false;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;

  readonly #armed = new Map<string, ArmedRoutine>();
  readonly #inFlightRoutines = new Set<string>();
  readonly #inFlightPromises = new Set<Promise<void>>();

  constructor(options: FileWatchTriggerProviderOptions) {
    this.#settings = options.settings;
    this.#now = options.now ?? Date.now;
    this.#timed = options.timer ?? true;
    this.#home = options.home ?? homedir();
    this.#platform = options.platform ?? process.platform;
    this.#maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.#watchOption = options.watch;
    this.#fs = options.fs ?? DEFAULT_FS;
    this.#backoffBaseMs = options.backoffBaseMs;
    this.#backoffMaxMs = options.backoffMaxMs;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  status(): TriggerProviderStatus {
    return { provider: this.id, status: "ready" };
  }

  /** Current in-memory watch & fallback poll snapshot for one routine (for diagnostics/tests). */
  pollState(routineId: string): FileWatchPollSnapshot | undefined {
    const armed = this.#armed.get(routineId);
    if (armed === undefined) return undefined;
    return {
      nextPollAt: armed.nextPollAt,
      consecutiveFailures: armed.consecutiveFailures,
      lastError: armed.lastError,
      watcherActive: armed.watcherActive,
      watchedCount: armed.watchedCount,
    };
  }

  async listTriggers(filter?: {
    source?: string;
    query?: string;
    refresh?: boolean;
  }): Promise<TriggerCatalogItem[]> {
    const sourceFilter = filter?.source?.trim();
    if (
      sourceFilter !== undefined &&
      sourceFilter !== "" &&
      sourceFilter !== FILE_WATCH_SOURCE_SLUG
    ) {
      return [];
    }
    const query = filter?.query?.trim().toLowerCase();
    if (query !== undefined && query !== "") {
      const haystack = [
        FILE_WATCH_CATALOG_ITEM.provider,
        FILE_WATCH_CATALOG_ITEM.source,
        FILE_WATCH_CATALOG_ITEM.sourceName,
        FILE_WATCH_CATALOG_ITEM.trigger,
        FILE_WATCH_CATALOG_ITEM.name,
        FILE_WATCH_CATALOG_ITEM.description,
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) return [];
    }
    return [FILE_WATCH_CATALOG_ITEM];
  }

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    const config = parseFileWatchConfig(
      input.trigger,
      this.#home,
      this.#platform,
    );
    const checkedAt = this.#now();
    let snapshot: Record<string, FileSnapshotEntry>;
    try {
      snapshot = await this.#scanTarget(config);
    } catch (error) {
      this.#host?.onTriggerChecked?.(input.routineId, checkedAt);
      throw error;
    }

    const watchedCount = Object.keys(snapshot).length;
    const existing = this.#readState(input.routineId);
    const sameConfig =
      input.existingInstanceId !== null &&
      existing !== undefined &&
      existing.seeded &&
      existing.configFingerprint === config.fingerprint;

    this.#writeState(input.routineId, {
      configFingerprint: config.fingerprint,
      path: config.path,
      seeded: true,
      snapshot: sameConfig ? existing.snapshot : snapshot,
      lastScannedAt: checkedAt,
      watchedCount,
    });

    const instanceId = instanceIdOf(input.routineId);
    this.#disarm(input.routineId);
    this.syncBindings();
    return {
      instanceId,
      accountId: null,
      mode: "poll",
      pollingIntervalMinutes: config.pollingIntervalMinutes,
      fallbackReason: null,
      active: input.enabled,
      config: config.persistedConfig,
      lastCheckedAt: checkedAt,
      watchedCount,
    };
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    if (!enabled) {
      this.#disarm(routineId);
      this.#scheduleTimer();
      return;
    }
    const state = this.#readState(routineId);
    if (state === undefined || !state.seeded) {
      throw new Error("File Watch trigger state is missing; re-provisioning");
    }
    const armed = this.#armed.get(routineId);
    if (armed !== undefined) {
      armed.consecutiveFailures = 0;
      armed.lastError = null;
      armed.nextPollAt = nextPollTime(
        state.lastScannedAt,
        armed.intervalMs,
        this.#now(),
      );
    }
    this.syncBindings();
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    this.#settings.delete(settingKey(routineId));
    this.#disarm(routineId);
    this.#inFlightRoutines.delete(routineId);
    this.#scheduleTimer();
  }

  start(host: TriggerProviderHost): void {
    this.#host = host;
    this.#stopped = false;
    this.#started = true;
    this.syncBindings();
  }

  syncBindings(): void {
    if (!this.#started || this.#stopped) return;
    const now = this.#now();
    const bindings = this.#host?.bindings() ?? [];
    const live = new Set<string>();

    for (const binding of bindings) {
      if (
        binding.trigger.provider !== this.id ||
        !binding.enabled ||
        binding.instanceId === null
      ) {
        continue;
      }
      let config: ParsedFileWatchConfig;
      try {
        config = parseFileWatchConfig(
          binding.trigger,
          this.#home,
          this.#platform,
        );
      } catch (error) {
        this.#warn(
          `[eta] file-watch binding ${binding.routineId} has invalid config: ${errorMessage(error)}`,
        );
        continue;
      }
      live.add(binding.routineId);
      const intervalMs = config.pollingIntervalMinutes * 60_000;
      const key = JSON.stringify([
        binding.instanceId,
        config.fingerprint,
        intervalMs,
      ]);
      const existing = this.#armed.get(binding.routineId);
      if (existing !== undefined && existing.key === key) continue;

      this.#disarm(binding.routineId);
      const persisted = this.#readState(binding.routineId);
      const lastScannedAt =
        persisted !== undefined &&
        persisted.configFingerprint === config.fingerprint
          ? persisted.lastScannedAt
          : undefined;
      const entry: ArmedRoutine = {
        routineId: binding.routineId,
        instanceId: binding.instanceId,
        key,
        config,
        intervalMs,
        nextPollAt: nextPollTime(lastScannedAt, intervalMs, now),
        consecutiveFailures: 0,
        lastError: null,
        generation: ++this.#generation,
        watcher: undefined,
        watcherActive: false,
        debounceTimer: undefined,
        rescanPending: false,
        watchedCount: persisted?.watchedCount ?? 0,
      };
      this.#armed.set(binding.routineId, entry);
      this.#attachWatcher(entry);
    }

    for (const routineId of [...this.#armed.keys()]) {
      if (!live.has(routineId)) this.#disarm(routineId);
    }
    this.#scheduleTimer(now);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const routineId of [...this.#armed.keys()]) {
      this.#disarm(routineId);
    }
    await Promise.allSettled([...this.#inFlightPromises]);
    this.#inFlightRoutines.clear();
  }

  /** Polls any currently due bindings once and re-arms the fallback timer. */
  async tick(): Promise<void> {
    if (!this.#started || this.#stopped) return;
    const now = this.#now();
    const due: ArmedRoutine[] = [];
    for (const armed of this.#armed.values()) {
      if (
        armed.nextPollAt <= now &&
        !this.#inFlightRoutines.has(armed.routineId)
      ) {
        due.push(armed);
      }
    }
    if (due.length > 0) {
      await Promise.allSettled(due.map((entry) => this.#enqueueScan(entry)));
    }
    if (!this.#stopped && this.#started) this.#scheduleTimer();
  }

  /** Forces an immediate scan for one or all armed routines (useful for tests/diagnostics). */
  async scanNow(routineId?: string): Promise<void> {
    if (!this.#started || this.#stopped) return;
    const targets =
      routineId === undefined
        ? [...this.#armed.values()]
        : [this.#armed.get(routineId)].filter(
            (entry): entry is ArmedRoutine => entry !== undefined,
          );
    await Promise.allSettled(targets.map((entry) => this.#enqueueScan(entry)));
  }

  #disarm(routineId: string): void {
    const existing = this.#armed.get(routineId);
    if (existing === undefined) return;
    clearTimeout(existing.debounceTimer);
    existing.debounceTimer = undefined;
    existing.rescanPending = false;
    existing.watcherActive = false;
    if (existing.watcher !== undefined) {
      try {
        existing.watcher.close();
      } catch {
        // Ignore close errors on already-closed watchers.
      }
      existing.watcher = undefined;
    }
    this.#armed.delete(routineId);
  }

  #attachWatcher(entry: ArmedRoutine): void {
    if (this.#stopped || !this.#started) return;
    if (this.#watchOption === false) return;
    const watchFn = this.#watchOption ?? nodeWatch;
    const { routineId, generation, config } = entry;

    const onEvent: FileWatchListener = (_eventType, rawFilename) => {
      if (
        this.#stopped ||
        !this.#started ||
        !this.#isCurrent(routineId, generation)
      ) {
        return;
      }
      const filename =
        typeof rawFilename === "string"
          ? rawFilename
          : Buffer.isBuffer(rawFilename)
            ? rawFilename.toString("utf8")
            : null;
      if (filename !== null && isGitRelativePath(filename)) return;
      this.#scheduleDebounce(entry);
    };

    const bindError = (watcher: FSWatcher) => {
      watcher.on("error", (error: unknown) => {
        if (entry.watcher === watcher) {
          entry.watcher = undefined;
          entry.watcherActive = false;
        }
        try {
          watcher.close();
        } catch {
          // Ignore close failure after watcher error.
        }
        if (!this.#stopped && this.#isCurrent(routineId, generation)) {
          this.#warn(
            `[eta] file-watch watcher degraded to polling fallback for routine ${routineId}: ${errorMessage(error)}`,
          );
        }
      });
    };

    try {
      const watcher = watchFn(
        config.path,
        { recursive: true, persistent: false },
        onEvent,
      );
      bindError(watcher);
      entry.watcher = watcher;
      entry.watcherActive = true;
    } catch (recursiveError) {
      try {
        const fallbackWatcher = watchFn(
          config.path,
          { recursive: false, persistent: false },
          onEvent,
        );
        bindError(fallbackWatcher);
        entry.watcher = fallbackWatcher;
        entry.watcherActive = true;
        this.#warn(
          `[eta] file-watch recursive watch unavailable for routine ${routineId}; using shallow watch + polling fallback: ${errorMessage(recursiveError)}`,
        );
      } catch (shallowError) {
        entry.watcher = undefined;
        entry.watcherActive = false;
        this.#warn(
          `[eta] file-watch fs.watch failed for routine ${routineId}; using polling fallback: ${errorMessage(shallowError)}`,
        );
      }
    }
  }

  #scheduleDebounce(entry: ArmedRoutine): void {
    if (this.#stopped || !this.#started) return;
    const { routineId, generation, config } = entry;
    clearTimeout(entry.debounceTimer);
    if (this.#inFlightRoutines.has(routineId)) {
      entry.rescanPending = true;
      return;
    }
    const timer = setTimeout(() => {
      entry.debounceTimer = undefined;
      if (
        this.#stopped ||
        !this.#started ||
        !this.#isCurrent(routineId, generation)
      ) {
        return;
      }
      void this.#enqueueScan(entry);
    }, config.debounceMs);
    timer.unref?.();
    entry.debounceTimer = timer;
  }

  #enqueueScan(entry: ArmedRoutine): Promise<void> {
    if (
      this.#stopped ||
      !this.#started ||
      this.#inFlightRoutines.has(entry.routineId)
    ) {
      return Promise.resolve();
    }
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = undefined;
    this.#inFlightRoutines.add(entry.routineId);
    const task = this.#scanLimit(() => this.#scanOne(entry)).finally(() => {
      this.#inFlightRoutines.delete(entry.routineId);
      this.#inFlightPromises.delete(task);
      if (
        entry.rescanPending &&
        !this.#stopped &&
        this.#started &&
        this.#isCurrent(entry.routineId, entry.generation)
      ) {
        entry.rescanPending = false;
        this.#scheduleDebounce(entry);
      }
    });
    this.#inFlightPromises.add(task);
    return task;
  }

  async #scanOne(entry: ArmedRoutine): Promise<void> {
    const { routineId, generation, config, intervalMs } = entry;
    if (
      this.#stopped ||
      !this.#started ||
      !this.#isCurrent(routineId, generation)
    ) {
      return;
    }

    try {
      const nextSnapshot = await this.#scanTarget(config);
      if (
        this.#stopped ||
        !this.#started ||
        !this.#isCurrent(routineId, generation)
      ) {
        return;
      }

      const now = this.#now();
      const persisted = this.#readState(routineId);
      const sameConfig =
        persisted !== undefined &&
        persisted.seeded &&
        persisted.configFingerprint === config.fingerprint;
      const prevSnapshot = sameConfig ? persisted.snapshot : {};
      const changes = sameConfig
        ? diffSnapshots(config.path, prevSnapshot, nextSnapshot)
        : [];
      const watchedCount = Object.keys(nextSnapshot).length;

      this.#writeState(routineId, {
        configFingerprint: config.fingerprint,
        path: config.path,
        seeded: true,
        snapshot: nextSnapshot,
        lastScannedAt: now,
        watchedCount,
      });

      entry.watchedCount = watchedCount;
      entry.consecutiveFailures = 0;
      entry.lastError = null;
      entry.nextPollAt = now + intervalMs;

      this.#host?.onTriggerChecked?.(routineId, now);
      this.#host?.onTriggerWatchedCount?.(routineId, watchedCount);
      this.#host?.onTriggerRecovered?.(routineId);

      for (const change of changes) {
        if (
          this.#stopped ||
          !this.#started ||
          !this.#isCurrent(routineId, generation)
        ) {
          return;
        }
        this.#host?.onEvent({
          provider: FILE_WATCH_PROVIDER_ID,
          instanceId: entry.instanceId,
          routineId,
          triggerSlug: FILE_WATCH_TRIGGER_SLUG,
          source: FILE_WATCH_SOURCE_SLUG,
          accountId: null,
          eventId: change.eventId,
          occurredAt: now,
          payload: change.payload,
        });
      }

      if (!entry.watcherActive && this.#watchOption !== false) {
        this.#attachWatcher(entry);
      }
    } catch (error) {
      if (
        this.#stopped ||
        !this.#started ||
        !this.#isCurrent(routineId, generation)
      ) {
        return;
      }
      const now = this.#now();
      const message = errorMessage(error);
      entry.consecutiveFailures += 1;
      entry.lastError = message;
      entry.nextPollAt =
        now +
        backoffDelayMs(
          entry.consecutiveFailures,
          intervalMs,
          this.#backoffBaseMs,
          this.#backoffMaxMs,
        );
      this.#host?.onTriggerChecked?.(routineId, now);
      this.#warn(
        `[eta] file-watch scan failed for routine ${routineId}: ${message}`,
      );
      this.#host?.onTriggerError?.(routineId, message);
    }
  }

  async #scanTarget(
    config: ParsedFileWatchConfig,
  ): Promise<Record<string, FileSnapshotEntry>> {
    let rootStat: Awaited<ReturnType<FileWatchFs["lstat"]>>;
    try {
      rootStat = await this.#fs.lstat(config.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        throw new Error(`Watch path does not exist: ${config.path}`);
      }
      throw new Error(`Cannot access watch path: ${errorMessage(error)}`);
    }

    if (rootStat.isSymbolicLink()) {
      throw new Error("Watch path cannot be a symbolic link");
    }

    if (rootStat.isFile()) {
      const relPath = normalizeRelPath(basename(config.path) || config.path);
      if (
        !matchesFilters(relPath, config.includePatterns, config.ignorePatterns)
      ) {
        return {};
      }
      if (this.#maxFiles < 1) {
        throw new Error(
          `Watched file count (1) exceeds limit (${this.#maxFiles}); narrow the path or add glob/ignore filters`,
        );
      }
      return {
        [relPath]: {
          mtimeMs: finiteNumber(rootStat.mtimeMs),
          size: finiteNumber(rootStat.size),
        },
      };
    }

    if (!rootStat.isDirectory()) {
      throw new Error("Watch path must be a regular file or directory");
    }

    const maxEntries = Math.max(this.#maxFiles * 20, MAX_SCAN_ENTRIES_FLOOR);
    const snapshot: Record<string, FileSnapshotEntry> = {};
    let watchedCount = 0;
    let visitedEntries = 0;
    const queue: { dir: string; depth: number }[] = [
      { dir: config.path, depth: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const entries = await this.#fs.readdir(current.dir, {
        withFileTypes: true,
      });
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const dirent of entries) {
        if (dirent.name === ".git") continue;
        visitedEntries += 1;
        if (visitedEntries > maxEntries) {
          throw new Error(
            `Directory traversal exceeded limit (${maxEntries} entries); narrow the path or add ignore filters`,
          );
        }
        if (dirent.isSymbolicLink()) continue;

        const fullPath = join(current.dir, dirent.name);
        const relPath = normalizeRelPath(relative(config.path, fullPath));

        if (dirent.isDirectory()) {
          if (matchesIgnore(relPath, config.ignorePatterns)) continue;
          if (current.depth + 1 <= MAX_SCAN_DEPTH) {
            queue.push({ dir: fullPath, depth: current.depth + 1 });
          }
          continue;
        }

        if (!dirent.isFile()) continue;
        if (
          !matchesFilters(
            relPath,
            config.includePatterns,
            config.ignorePatterns,
          )
        ) {
          continue;
        }

        let stat: Awaited<ReturnType<FileWatchFs["lstat"]>>;
        try {
          stat = await this.#fs.lstat(fullPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | undefined)?.code;
          if (code === "ENOENT") continue;
          throw error;
        }
        if (stat.isSymbolicLink() || !stat.isFile()) continue;

        watchedCount += 1;
        if (watchedCount > this.#maxFiles) {
          throw new Error(
            `Watched file count exceeds limit (${this.#maxFiles}); narrow the path or add glob/ignore filters`,
          );
        }
        snapshot[relPath] = {
          mtimeMs: finiteNumber(stat.mtimeMs),
          size: finiteNumber(stat.size),
        };
      }
    }

    return snapshot;
  }

  #isCurrent(routineId: string, generation: number): boolean {
    return this.#armed.get(routineId)?.generation === generation;
  }

  #scheduleTimer(now = this.#now()): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.#stopped || !this.#timed) return;

    let soonest = Infinity;
    for (const armed of this.#armed.values()) {
      if (this.#inFlightRoutines.has(armed.routineId)) continue;
      if (armed.nextPollAt < soonest) soonest = armed.nextPollAt;
    }
    if (!Number.isFinite(soonest)) return;

    const wait = Math.min(MAX_SLEEP_MS, Math.max(1, soonest - now));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.tick().catch((error: unknown) => {
        this.#warn(
          `[eta] file-watch polling loop failed: ${errorMessage(error)}`,
        );
        this.#scheduleTimer();
      });
    }, wait);
    this.#timer.unref?.();
  }

  #readState(routineId: string): PersistedFileWatchState | undefined {
    const raw = this.#settings.get(settingKey(routineId));
    if (!isPlain(raw)) return undefined;
    if (
      typeof raw.configFingerprint !== "string" ||
      raw.configFingerprint === ""
    ) {
      return undefined;
    }
    if (typeof raw.path !== "string" || raw.path === "") return undefined;

    const snapshot: Record<string, FileSnapshotEntry> = {};
    if (isPlain(raw.snapshot)) {
      for (const [key, value] of Object.entries(raw.snapshot)) {
        if (!isPlain(value)) continue;
        if (
          typeof value.mtimeMs === "number" &&
          Number.isFinite(value.mtimeMs) &&
          typeof value.size === "number" &&
          Number.isFinite(value.size)
        ) {
          snapshot[key] = { mtimeMs: value.mtimeMs, size: value.size };
        }
      }
    }

    return {
      configFingerprint: raw.configFingerprint,
      path: raw.path,
      seeded: raw.seeded === true,
      snapshot,
      lastScannedAt:
        typeof raw.lastScannedAt === "number" &&
        Number.isFinite(raw.lastScannedAt)
          ? raw.lastScannedAt
          : this.#now(),
      watchedCount:
        typeof raw.watchedCount === "number" &&
        Number.isFinite(raw.watchedCount)
          ? raw.watchedCount
          : Object.keys(snapshot).length,
    };
  }

  #writeState(routineId: string, state: PersistedFileWatchState): void {
    this.#settings.set(settingKey(routineId), state);
  }
}

/* ---------------------------------------------------------- config & diff */

function parseFileWatchConfig(
  trigger: RoutineTrigger,
  homeDir: string,
  platform: NodeJS.Platform,
): ParsedFileWatchConfig {
  if (trigger.source !== FILE_WATCH_SOURCE_SLUG) {
    throw new Error(
      `File Watch trigger source must be "${FILE_WATCH_SOURCE_SLUG}"`,
    );
  }
  if (trigger.trigger !== FILE_WATCH_TRIGGER_SLUG) {
    throw new Error(
      `File Watch trigger slug must be "${FILE_WATCH_TRIGGER_SLUG}"`,
    );
  }
  if (
    trigger.mode !== undefined &&
    trigger.mode !== null &&
    trigger.mode !== "poll"
  ) {
    throw new Error('File Watch trigger only supports "poll" mode');
  }

  const cfg = isPlain(trigger.config) ? trigger.config : {};
  const rawPolling =
    trigger.pollingIntervalMinutes ??
    (cfg.pollingIntervalMinutes === undefined
      ? null
      : cfg.pollingIntervalMinutes);
  let pollingIntervalMinutes = DEFAULT_POLL_MINUTES;
  if (rawPolling !== undefined && rawPolling !== null) {
    if (
      typeof rawPolling !== "number" ||
      !Number.isInteger(rawPolling) ||
      rawPolling < MIN_POLL_MINUTES ||
      rawPolling > MAX_POLL_MINUTES
    ) {
      throw new Error(
        `File Watch pollingIntervalMinutes must be an integer between ${MIN_POLL_MINUTES} and ${MAX_POLL_MINUTES}`,
      );
    }
    pollingIntervalMinutes = rawPolling;
  }

  const rawPath = typeof cfg.path === "string" ? cfg.path.trim() : "";
  if (rawPath === "") {
    throw new Error("Watch path is required (config.path)");
  }

  const rules = new PathRules(flavorOf(platform), homeDir);
  const resolved = rules.resolve(rawPath);
  if (!resolved.ok) {
    if (resolved.failure.code === "not_absolute") {
      throw new Error(
        'Watch path must be an absolute path or start with "~" (config.path)',
      );
    }
    throw new Error("Watch path is invalid (config.path)");
  }
  if (rules.parent(resolved.path) === null) {
    throw new Error(
      "Refusing to watch a filesystem or drive root directory (config.path)",
    );
  }

  const glob = parsePatternList(cfg.glob, "config.glob");
  const ignore = parsePatternList(cfg.ignore, "config.ignore");
  const includePatterns = glob.patterns.map(compileGlob);
  const ignorePatterns = ignore.patterns.map(compileGlob);

  let debounceMs = DEFAULT_DEBOUNCE_MS;
  if (cfg.debounceMs !== undefined && cfg.debounceMs !== null) {
    if (
      typeof cfg.debounceMs !== "number" ||
      !Number.isInteger(cfg.debounceMs) ||
      cfg.debounceMs < MIN_DEBOUNCE_MS ||
      cfg.debounceMs > MAX_DEBOUNCE_MS
    ) {
      throw new Error(
        `File Watch config.debounceMs must be an integer between ${MIN_DEBOUNCE_MS} and ${MAX_DEBOUNCE_MS}`,
      );
    }
    debounceMs = cfg.debounceMs;
  }

  const persistedConfig: Record<string, unknown> = {
    path: resolved.path,
    ...(glob.text === null ? {} : { glob: glob.text }),
    ...(ignore.text === null ? {} : { ignore: ignore.text }),
    debounceMs,
  };

  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        resolved.path,
        glob.patterns,
        ignore.patterns,
        debounceMs,
      ]),
    )
    .digest("hex");

  return {
    path: resolved.path,
    glob: glob.text,
    ignore: ignore.text,
    includePatterns,
    ignorePatterns,
    debounceMs,
    pollingIntervalMinutes,
    persistedConfig,
    fingerprint,
  };
}

function parsePatternList(
  raw: unknown,
  label: string,
): { text: string | null; patterns: string[] } {
  if (raw === undefined || raw === null) return { text: null, patterns: [] };
  let items: string[];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { text: null, patterns: [] };
    items = splitGlobList(trimmed);
  } else if (Array.isArray(raw)) {
    items = [];
    for (const entry of raw) {
      if (typeof entry !== "string") {
        throw new TypeError(`${label} entries must be strings`);
      }
      const trimmed = entry.trim();
      if (trimmed !== "") items.push(trimmed);
    }
    if (items.length === 0) return { text: null, patterns: [] };
  } else {
    throw new TypeError(`${label} must be a string or string array`);
  }

  return {
    text: items.join(", "),
    patterns: items,
  };
}

function splitGlobList(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let inClass = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      current += ch;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      current += ch;
      continue;
    }
    if (!inClass) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}" && braceDepth > 0) braceDepth -= 1;
      else if (ch === "," && braceDepth === 0) {
        const trimmed = current.trim();
        if (trimmed !== "") parts.push(trimmed);
        current = "";
        continue;
      }
    }
    current += ch;
  }

  const tail = current.trim();
  if (tail !== "") parts.push(tail);
  return parts;
}

function compileGlob(rawInput: string): CompiledGlob {
  const raw = rawInput.replaceAll("\\", "/").replace(/^\.\//, "");
  if (raw === "" || raw.includes("\0")) {
    throw new Error(`Invalid glob pattern: "${rawInput}"`);
  }
  validateGlobSyntax(raw, rawInput);
  const hasSlash = raw.includes("/");
  const fullRegex = new RegExp(`^${globPatternToRegexBody(raw)}$`);
  const segmentRegex = hasSlash
    ? null
    : new RegExp(`^${globPatternToRegexBody(raw)}$`);
  const prefixRegex = hasSlash
    ? null
    : new RegExp(`(?:^|/)${globPatternToRegexBody(raw)}(?:/.*)?$`);
  return { raw, hasSlash, fullRegex, segmentRegex, prefixRegex };
}

function validateGlobSyntax(pattern: string, original: string): void {
  let braceDepth = 0;
  let inClass = false;
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (ch === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (!inClass) {
      if (ch === "{") braceDepth += 1;
      else if (ch === "}") {
        braceDepth -= 1;
        if (braceDepth < 0) {
          throw new Error(
            `Invalid glob pattern (unmatched "}"): "${original}"`,
          );
        }
      }
    }
  }
  if (inClass) {
    throw new Error(`Invalid glob pattern (unclosed "["): "${original}"`);
  }
  if (braceDepth !== 0) {
    throw new Error(`Invalid glob pattern (unclosed "{"): "${original}"`);
  }
}

function globPatternToRegexBody(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next !== undefined) {
        out += escapeRegexChar(next);
        i += 2;
      } else {
        out += "\\\\";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const after = pattern[i + 2];
        if (after === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end !== -1) {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = end + 1;
        continue;
      }
    }
    if (ch === "{") {
      const close = findMatchingBrace(pattern, i);
      if (close !== -1) {
        const inner = pattern.slice(i + 1, close);
        const branches = splitTopLevelCommas(inner).map((branch) =>
          globPatternToRegexBody(branch),
        );
        out += `(?:${branches.join("|")})`;
        i = close + 1;
        continue;
      }
    }
    out += escapeRegexChar(ch);
    i += 1;
  }
  return out;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inClass = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (!inClass) {
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let inClass = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      cur += ch;
      escaped = true;
      continue;
    }
    if (ch === "[" && !inClass) inClass = true;
    else if (ch === "]" && inClass) inClass = false;
    else if (!inClass) {
      if (ch === "{") depth += 1;
      else if (ch === "}" && depth > 0) depth -= 1;
      else if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function escapeRegexChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesIgnore(
  relPath: string,
  ignorePatterns: readonly CompiledGlob[],
): boolean {
  if (isGitRelativePath(relPath)) return true;
  if (ignorePatterns.length === 0) return false;
  const segments = relPath.split("/");
  return ignorePatterns.some((pattern) => {
    if (pattern.fullRegex.test(relPath)) return true;
    if (!pattern.hasSlash) {
      if (pattern.prefixRegex?.test(relPath)) return true;
      if (
        pattern.segmentRegex !== null &&
        segments.some((seg) => pattern.segmentRegex!.test(seg))
      ) {
        return true;
      }
    }
    return false;
  });
}

function matchesFilters(
  relPath: string,
  includePatterns: readonly CompiledGlob[],
  ignorePatterns: readonly CompiledGlob[],
): boolean {
  if (matchesIgnore(relPath, ignorePatterns)) return false;
  if (includePatterns.length === 0) return true;
  return includePatterns.some((pattern) => pattern.fullRegex.test(relPath));
}

function isGitRelativePath(relPath: string): boolean {
  return normalizeRelPath(relPath).split("/").includes(".git");
}

function normalizeRelPath(relPath: string): string {
  return sep === "/" ? relPath : relPath.split(sep).join("/");
}

function diffSnapshots(
  watchPath: string,
  prev: Record<string, FileSnapshotEntry>,
  curr: Record<string, FileSnapshotEntry>,
): { eventId: string; payload: FileWatchEventPayload }[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const sorted = [...keys].sort((a, b) => a.localeCompare(b));
  const events: { eventId: string; payload: FileWatchEventPayload }[] = [];

  for (const relativePath of sorted) {
    const before = prev[relativePath];
    const after = curr[relativePath];

    if (before === undefined && after !== undefined) {
      events.push({
        eventId: eventIdOf(
          watchPath,
          relativePath,
          "created",
          after.mtimeMs,
          after.size,
        ),
        payload: {
          watchPath,
          relativePath,
          changeType: "created",
          mtime: after.mtimeMs,
          mtimeIso: new Date(after.mtimeMs).toISOString(),
          size: after.size,
        },
      });
      continue;
    }

    if (before !== undefined && after === undefined) {
      events.push({
        eventId: eventIdOf(
          watchPath,
          relativePath,
          "deleted",
          before.mtimeMs,
          before.size,
        ),
        payload: {
          watchPath,
          relativePath,
          changeType: "deleted",
          mtime: null,
          mtimeIso: null,
          size: null,
        },
      });
      continue;
    }

    if (
      before !== undefined &&
      after !== undefined &&
      (before.mtimeMs !== after.mtimeMs || before.size !== after.size)
    ) {
      events.push({
        eventId: eventIdOf(
          watchPath,
          relativePath,
          "modified",
          after.mtimeMs,
          after.size,
        ),
        payload: {
          watchPath,
          relativePath,
          changeType: "modified",
          mtime: after.mtimeMs,
          mtimeIso: new Date(after.mtimeMs).toISOString(),
          size: after.size,
        },
      });
    }
  }

  return events;
}

function eventIdOf(
  watchPath: string,
  relativePath: string,
  changeType: FileWatchChangeType,
  mtimeMs: number,
  size: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        FILE_WATCH_PROVIDER_ID,
        watchPath,
        relativePath,
        changeType,
        mtimeMs,
        size,
      ]),
    )
    .digest("hex");
}

function nextPollTime(
  lastScannedAt: number | undefined,
  intervalMs: number,
  now: number,
): number {
  if (lastScannedAt === undefined || !Number.isFinite(lastScannedAt)) {
    return now + intervalMs;
  }
  const clamped = Math.min(lastScannedAt, now);
  return Math.max(now, clamped + intervalMs);
}

function backoffDelayMs(
  failures: number,
  intervalMs: number,
  baseOverride?: number,
  maxOverride?: number,
): number {
  const base = baseOverride ?? intervalMs * 2;
  const max = maxOverride ?? Math.max(intervalMs, DEFAULT_BACKOFF_MAX_MS);
  const scaled = base * 2 ** Math.max(0, failures - 1);
  return Math.min(max, Math.max(1, scaled));
}

function settingKey(routineId: string): string {
  return `${SETTING_KEY_PREFIX}${routineId}`;
}

function instanceIdOf(routineId: string): string {
  return `${FILE_WATCH_PROVIDER_ID}:${routineId}`;
}

function routineIdOf(instanceId: string): string | null {
  const prefix = `${FILE_WATCH_PROVIDER_ID}:`;
  if (!instanceId.startsWith(prefix)) return null;
  const id = instanceId.slice(prefix.length).trim();
  return id === "" ? null : id;
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
