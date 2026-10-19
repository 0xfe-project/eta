// Ported from pi-mcp-adapter/metadata-cache.ts (MIT, see ../NOTICE); one class over one file, without TTLs, private scopes, resources or prompts.
/**
 * What the library knows about a server without connecting to it: its tool list, its instructions
 * and the output shapes seen so far. Search, list and describe read only this, so a stopped server
 * costs nothing until a tool is called.
 *
 * An entry is valid while the server's config hash is the one it was written under; any change to
 * how the server is started or reached, or which tools are filtered, drops it. The file is
 * rewritten whole through a rename, merged with what is on disk at that moment, so several
 * processes sharing a file lose nothing.
 */
import type { MetadataCacheFile, ServerCacheEntry } from "./types";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";

const CACHE_VERSION = 1;

function readFile(path: string): Record<string, ServerCacheEntry> {
  try {
    const raw = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<MetadataCacheFile> | null;
    if (!raw || raw.version !== CACHE_VERSION) return {};
    const servers = raw.servers;
    if (typeof servers !== "object" || servers === null) return {};
    return { ...servers };
  } catch {
    // Missing or corrupt: start empty. The next save replaces it.
    return {};
  }
}

export class MetadataCache {
  private servers: Record<string, ServerCacheEntry> | undefined;

  readonly path: string;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.path = path;
    this.now = now;
  }

  private load(): Record<string, ServerCacheEntry> {
    this.servers ??= readFile(this.path);
    return this.servers;
  }

  /** The entry for a server, if it was written under this config hash and found tools. */
  get(server: string, hash: string): ServerCacheEntry | undefined {
    const entry = this.load()[server];
    if (!entry || entry.configHash !== hash || entry.discoveryFailed)
      return undefined;
    return entry;
  }

  /** Whether discovery was tried under this config and failed. */
  discoveryFailed(server: string, hash: string): boolean {
    const entry = this.load()[server];
    return entry?.configHash === hash && entry.discoveryFailed === true;
  }

  /** Stores entries, keeping observed shapes of tools whose definition did not change. */
  save(updates: Record<string, Omit<ServerCacheEntry, "cachedAt">>): void {
    // Re-read: another process may have written since we loaded.
    const servers = readFile(this.path);
    for (const [name, update] of Object.entries(updates)) {
      const previous = servers[name] ?? this.servers?.[name];
      const outputShapes =
        update.outputShapes ??
        (previous?.configHash === update.configHash
          ? previous.outputShapes
          : undefined);
      servers[name] = {
        ...update,
        ...(outputShapes === undefined ? {} : { outputShapes }),
        cachedAt: this.now(),
      };
    }
    this.write(servers);
  }

  /** Drops a server's entry (the config no longer has it). */
  remove(server: string): void {
    const servers = readFile(this.path);
    if (!(server in servers)) return;
    delete servers[server];
    this.write(servers);
  }

  private write(servers: Record<string, ServerCacheEntry>): void {
    this.servers = servers;
    const payload: MetadataCacheFile = { version: CACHE_VERSION, servers };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(payload), "utf8");
      renameSync(temporary, this.path);
    } catch {
      // The cache is an optimisation; the in-memory copy still serves this process.
    }
  }
}
