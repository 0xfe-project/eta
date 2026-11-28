import type { HostAddress } from "../services/host";
import { context, signal, Storage, untracked } from "nsh";
import { addressFrom } from "../services/host";

export const LEGACY_HOST_KEY = "eta.host";
export const SAVED_HOSTS_KEY = "eta.hosts.v1";

const MAX_HOST_NAME_LENGTH = 80;

export interface SavedHost extends HostAddress {
  /** User-chosen alias for this host; omitted when using the host address itself. */
  name?: string;
  /** Epoch milliseconds when this host was last connected (or migrated). */
  lastConnectedAt: number;
}

export interface HostStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
}

export function normalizeHostOrigin(value: string): string | null {
  if (!value.trim()) return null;
  try {
    return addressFrom(value);
  } catch {
    return null;
  }
}

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX_HOST_NAME_LENGTH);
  return trimmed || undefined;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toHostAddress(host: HostAddress): HostAddress {
  const origin = normalizeHostOrigin(host.origin) ?? host.origin.trim();
  const token = normalizeToken(host.token);
  return {
    origin,
    ...(token ? { token } : {}),
    ...(host.local === true ? { local: true } : {}),
  };
}

export function sameHostAddress(
  a: HostAddress | null | undefined,
  b: HostAddress | null | undefined,
): boolean {
  if (!a || !b) return false;
  const originA = normalizeHostOrigin(a.origin);
  const originB = normalizeHostOrigin(b.origin);
  if (!originA || originA !== originB) return false;
  return (
    normalizeToken(a.token) === normalizeToken(b.token) &&
    Boolean(a.local) === Boolean(b.local)
  );
}

/**
 * Whether switching to a saved host should run `startLocalHost()` first so an ephemeral-port
 * desktop host is started/resumed instead of dialing a stale port.
 */
export function needsLocalHostStart(state: {
  address: HostAddress;
  activeOrigin?: string | null;
  activeOpen: boolean;
  canStartHost: boolean;
}): boolean {
  if (!state.address.local || !state.canStartHost) return false;
  const target = normalizeHostOrigin(state.address.origin);
  const active = state.activeOrigin
    ? normalizeHostOrigin(state.activeOrigin)
    : null;
  if (state.activeOpen && target && active && target === active) return false;
  return true;
}

export function hostOriginLabel(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

export function hostDisplayName(
  host: Pick<SavedHost, "origin" | "name">,
): string {
  return normalizeName(host.name) ?? hostOriginLabel(host.origin);
}

function sortAndDedup(entries: readonly SavedHost[]): SavedHost[] {
  const byOrigin = new Map<string, SavedHost>();
  for (const entry of entries) {
    const origin = normalizeHostOrigin(entry.origin);
    if (!origin) continue;
    const normalized: SavedHost = {
      origin,
      ...(normalizeToken(entry.token)
        ? { token: normalizeToken(entry.token) }
        : {}),
      ...(entry.local === true ? { local: true } : {}),
      ...(normalizeName(entry.name) ? { name: normalizeName(entry.name) } : {}),
      lastConnectedAt: normalizeTimestamp(entry.lastConnectedAt),
    };
    const existing = byOrigin.get(origin);
    if (!existing) {
      byOrigin.set(origin, normalized);
      continue;
    }
    const newer =
      normalized.lastConnectedAt >= existing.lastConnectedAt
        ? normalized
        : existing;
    const older = newer === normalized ? existing : normalized;
    const name = newer.name ?? older.name;
    byOrigin.set(origin, {
      ...newer,
      ...(name ? { name } : {}),
    });
  }
  return [...byOrigin.values()].sort(
    (left, right) =>
      right.lastConnectedAt - left.lastConnectedAt ||
      left.origin.localeCompare(right.origin),
  );
}

export function parseLegacyHost(
  raw: string | null | undefined,
): HostAddress | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.origin !== "string") return null;
  const origin = normalizeHostOrigin(parsed.origin);
  if (!origin) return null;
  const token = normalizeToken(parsed.token);
  return {
    origin,
    ...(token ? { token } : {}),
    ...(parsed.local === true ? { local: true } : {}),
  };
}

export function parseSavedHosts(raw: string | null | undefined): SavedHost[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: SavedHost[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.origin !== "string") continue;
    const origin = normalizeHostOrigin(item.origin);
    if (!origin) continue;
    const token = normalizeToken(item.token);
    const name = normalizeName(item.name);
    entries.push({
      origin,
      ...(token ? { token } : {}),
      ...(item.local === true ? { local: true } : {}),
      ...(name ? { name } : {}),
      lastConnectedAt: normalizeTimestamp(item.lastConnectedAt),
    });
  }
  return sortAndDedup(entries);
}

export function migrateSavedHosts(
  rawList: string | null | undefined,
  rawLegacy: string | null | undefined,
  now = 0,
): { hosts: SavedHost[]; active: HostAddress | null; migrated: boolean } {
  const list = parseSavedHosts(rawList);
  const legacy = parseLegacyHost(rawLegacy);
  if (legacy) {
    const exists = list.some((item) => item.origin === legacy.origin);
    if (exists) {
      return { hosts: list, active: legacy, migrated: false };
    }
    const hosts = sortAndDedup([
      ...list,
      { ...legacy, lastConnectedAt: normalizeTimestamp(now) },
    ]);
    return { hosts, active: legacy, migrated: true };
  }
  return {
    hosts: list,
    active: list[0] ? toHostAddress(list[0]) : null,
    migrated: false,
  };
}

export function upsertSavedHost(
  hosts: readonly SavedHost[],
  address: HostAddress,
  options?: { name?: string; now?: number },
): SavedHost[] {
  const origin = normalizeHostOrigin(address.origin);
  if (!origin) return sortAndDedup(hosts);
  const matches = (item: SavedHost) =>
    address.local === true
      ? item.local === true || normalizeHostOrigin(item.origin) === origin
      : normalizeHostOrigin(item.origin) === origin;
  const existing = hosts.find(matches);
  const name =
    options?.name !== undefined
      ? normalizeName(options.name)
      : normalizeName(existing?.name);
  const token = normalizeToken(address.token);
  const updated: SavedHost = {
    origin,
    ...(token ? { token } : {}),
    ...(address.local === true ? { local: true } : {}),
    ...(name ? { name } : {}),
    lastConnectedAt: normalizeTimestamp(options?.now ?? Date.now()),
  };
  const rest = hosts.filter((item) => !matches(item));
  return sortAndDedup([updated, ...rest]);
}

export function renameSavedHost(
  hosts: readonly SavedHost[],
  origin: string,
  name: string,
): SavedHost[] {
  const target = normalizeHostOrigin(origin);
  if (!target) return sortAndDedup(hosts);
  const nextName = normalizeName(name);
  return sortAndDedup(
    hosts.map((item) => {
      if (normalizeHostOrigin(item.origin) !== target) return item;
      const { name: _, ...rest } = item;
      return nextName ? { ...rest, name: nextName } : rest;
    }),
  );
}

export function removeSavedHost(
  hosts: readonly SavedHost[],
  origin: string,
): SavedHost[] {
  const target = normalizeHostOrigin(origin);
  if (!target) return sortAndDedup(hosts);
  return sortAndDedup(
    hosts.filter((item) => normalizeHostOrigin(item.origin) !== target),
  );
}

export interface SavedHostsStore {
  hosts: () => SavedHost[];
  loaded: () => boolean;
  load: () => Promise<HostAddress | null>;
  remember: (address: HostAddress, options?: { name?: string }) => SavedHost[];
  rename: (origin: string, name: string) => SavedHost[];
  remove: (origin: string) => SavedHost[];
  displayName: (origin: string | null | undefined) => string;
}

export function createSavedHosts(options?: {
  storage?: HostStorage;
  now?: () => number;
  initial?: SavedHost[];
  syncLegacy?: boolean;
}): SavedHostsStore {
  const storage = options?.storage ?? Storage;
  const now = options?.now ?? (() => Date.now());
  const syncLegacy = options?.syncLegacy ?? true;
  const hosts = signal<SavedHost[]>(
    options?.initial ? sortAndDedup(options.initial) : [],
  );
  const loaded = signal(false);
  let dirty = false;
  const removedOrigins = new Set<string>();
  const renamedOrigins = new Set<string>();
  let syncedLegacyOrigin: string | null = null;
  let loadPromise: Promise<HostAddress | null> | undefined;

  function persistList(next: readonly SavedHost[]) {
    void storage.setItem(SAVED_HOSTS_KEY, JSON.stringify(next)).catch(() => {});
  }

  function persistLegacy(address: HostAddress | null) {
    if (!syncLegacy) return;
    if (!address) {
      syncedLegacyOrigin = null;
      void storage.removeItem(LEGACY_HOST_KEY).catch(() => {});
      return;
    }
    const clean = toHostAddress(address);
    syncedLegacyOrigin = clean.origin;
    void storage
      .setItem(LEGACY_HOST_KEY, JSON.stringify(clean))
      .catch(() => {});
  }

  function load(): Promise<HostAddress | null> {
    if (loadPromise) return loadPromise;
    loadPromise = Promise.all([
      storage.getItem(SAVED_HOSTS_KEY).catch(() => null),
      storage.getItem(LEGACY_HOST_KEY).catch(() => null),
    ]).then(([rawList, rawLegacy]) => {
      const result = migrateSavedHosts(rawList, rawLegacy, now());
      if (result.active && syncedLegacyOrigin === null) {
        syncedLegacyOrigin = result.active.origin;
      }
      if (!dirty) {
        hosts.set(result.hosts);
        if (result.migrated) persistList(result.hosts);
      } else {
        const current = untracked(hosts);
        const byOrigin = new Map(current.map((item) => [item.origin, item]));
        const extras: SavedHost[] = [];
        for (const item of result.hosts) {
          if (removedOrigins.has(item.origin)) continue;
          const existing = byOrigin.get(item.origin);
          if (!existing) {
            extras.push(item);
          } else if (
            !renamedOrigins.has(item.origin) &&
            !existing.name &&
            item.name
          ) {
            byOrigin.set(item.origin, { ...existing, name: item.name });
          }
        }
        const merged = sortAndDedup([...byOrigin.values(), ...extras]);
        hosts.set(merged);
        persistList(merged);
      }
      loaded.set(true);
      return result.active;
    });
    return loadPromise;
  }

  function remember(
    address: HostAddress,
    opts?: { name?: string },
  ): SavedHost[] {
    const origin = normalizeHostOrigin(address.origin);
    if (!origin) return untracked(hosts);
    dirty = true;
    removedOrigins.delete(origin);
    if (opts?.name !== undefined) renamedOrigins.add(origin);
    const next = upsertSavedHost(untracked(hosts), address, {
      name: opts?.name,
      now: now(),
    });
    hosts.set(next);
    persistList(next);
    persistLegacy(address);
    return next;
  }

  function rename(origin: string, name: string): SavedHost[] {
    const normalized = normalizeHostOrigin(origin);
    if (normalized) renamedOrigins.add(normalized);
    dirty = true;
    const next = renameSavedHost(untracked(hosts), origin, name);
    hosts.set(next);
    persistList(next);
    return next;
  }

  function remove(origin: string): SavedHost[] {
    const normalized = normalizeHostOrigin(origin);
    if (!normalized) return untracked(hosts);
    dirty = true;
    removedOrigins.add(normalized);
    const next = removeSavedHost(untracked(hosts), normalized);
    hosts.set(next);
    persistList(next);
    if (syncedLegacyOrigin === normalized) {
      persistLegacy(next[0] ? toHostAddress(next[0]) : null);
    }
    return next;
  }

  function displayName(origin: string | null | undefined): string {
    if (!origin) return "";
    const normalized = normalizeHostOrigin(origin) ?? origin;
    const saved = hosts().find((item) => item.origin === normalized);
    return saved ? hostDisplayName(saved) : hostOriginLabel(normalized);
  }

  return {
    hosts: () => hosts(),
    loaded: () => loaded(),
    load,
    remember,
    rename,
    remove,
    displayName,
  };
}

const emptyStore: SavedHostsStore = {
  hosts: () => [],
  loaded: () => true,
  load: async () => null,
  remember: () => [],
  rename: () => [],
  remove: () => [],
  displayName: (origin) => (origin ? hostOriginLabel(origin) : ""),
};

export const SavedHosts = context<SavedHostsStore>(emptyStore);

export function useSavedHosts(): SavedHostsStore {
  return SavedHosts();
}
