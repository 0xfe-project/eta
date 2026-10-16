import type { ThinkingLevel } from "@eta/core";
/**
 * Settings: what a *new* session starts as.
 *
 * Deliberately narrow (eta-agent's list, kept whole): only the things that are useless to change
 * per message and have no better home — the folder, the persona, the model, the thinking level,
 * and how much history a compaction keeps. Everything else about a session is decided at the
 * moment it matters (which tools are installed, which prompt is composed) or lives in its own
 * file (`~/.eta/config.json` owns providers).
 *
 * The one rule that shapes the whole file: **settings are a starting point, not a live control.**
 * A session applies them when it is created; changing them afterwards does not reach back into
 * sessions that are already running. The alternative — settings that reconfigure running sessions
 * — is a second, invisible way for a session's model to change under the user, and the user
 * already has an explicit op for that (`sessions.modelSet`).
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { THINKING_LEVELS } from "@eta/core";

/** What a new session inherits. Every field is optional: absent means "the app's own default". */
export interface Settings {
  /** The folder new sessions start in. */
  cwd?: string;
  /** The persona card new sessions start on. */
  persona?: string;
  /** `provider:modelId`. */
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /** How many tokens of recent history a compaction keeps. */
  keepRecentTokens?: number;
}

export interface SettingsStoreOptions {
  /** The file. Conventionally `<dataDir>/settings.json`. */
  path: string;
  /** Diagnostics. */
  warn?: ((message: string) => void) | undefined;
}

/** The keys a patch may carry, and how each one is read. */
const STRING_KEYS = ["cwd", "persona", "model"] as const;

export class SettingsStore {
  readonly path: string;
  private readonly warn: (message: string) => void;
  private cached: Settings | undefined;

  constructor(options: SettingsStoreOptions) {
    this.path = options.path;
    this.warn = options.warn ?? (() => undefined);
  }

  /**
   * The current defaults. A file that is missing is an empty settings object (first run), and
   * one that does not parse is reported and treated as empty — unlike the providers config,
   * there is nothing here worth refusing to overwrite: losing a default folder costs one
   * dialog, while a settings file that cannot be saved is a settings page that never works.
   */
  async read(): Promise<Settings> {
    if (this.cached !== undefined) return { ...this.cached };
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      this.cached = {};
      return {};
    }
    try {
      const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
      this.cached = normalize(parsed);
    } catch {
      this.warn(
        `[eta-server] ${this.path} is not valid JSON; using no defaults`,
      );
      this.cached = {};
    }
    return { ...this.cached };
  }

  /** Merge a patch over the stored defaults and persist. `null` clears a key. */
  async save(patch: Record<string, unknown>): Promise<Settings> {
    const next: Settings = { ...(await this.read()) };
    for (const key of STRING_KEYS) {
      const value = patch[key];
      if (value === null) {
        delete next[key];
        continue;
      }
      if (typeof value === "string" && value.trim().length > 0)
        next[key] = value.trim();
    }
    const thinking = patch.thinkingLevel;
    if (thinking === null) delete next.thinkingLevel;
    else if (
      typeof thinking === "string" &&
      (THINKING_LEVELS as readonly string[]).includes(thinking)
    ) {
      next.thinkingLevel = thinking as ThinkingLevel;
    }
    const keep = patch.keepRecentTokens;
    if (keep === null) delete next.keepRecentTokens;
    else if (typeof keep === "number" && Number.isSafeInteger(keep) && keep > 0)
      next.keepRecentTokens = keep;

    const raw = `${JSON.stringify(next, null, "\t")}\n`;
    const temporary = `${this.path}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      // Atomic like everything else that is read by someone who did not write it: a settings
      // page that reads a half-written file sees defaults nobody chose.
      await writeFile(temporary, raw, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
    this.cached = next;
    return { ...next };
  }

  /** Forget the cached copy, so the next read comes from disk (a test, an external edit). */
  invalidate(): void {
    this.cached = undefined;
  }
}

/** Where the settings file lives for a given data directory. */
export function settingsPath(dataDir: string): string {
  return join(dataDir, "settings.json");
}

/** Keep only the keys this file owns, and only in the shapes it accepts. */
function normalize(value: unknown): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const raw = value as Record<string, unknown>;
  const settings: Settings = {};
  for (const key of STRING_KEYS) {
    const entry = raw[key];
    if (typeof entry === "string" && entry.trim().length > 0)
      settings[key] = entry.trim();
  }
  if (
    typeof raw.thinkingLevel === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)
  ) {
    settings.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
  }
  if (
    typeof raw.keepRecentTokens === "number" &&
    Number.isSafeInteger(raw.keepRecentTokens) &&
    raw.keepRecentTokens > 0
  ) {
    settings.keepRecentTokens = raw.keepRecentTokens;
  }
  return settings;
}
