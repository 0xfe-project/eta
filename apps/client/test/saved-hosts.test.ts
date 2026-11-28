import type { HostStorage, SavedHost } from "../src/app/saved-hosts";
import { expect, test } from "nsh/test";
import {
  createSavedHosts,
  hostDisplayName,
  hostOriginLabel,
  LEGACY_HOST_KEY,
  migrateSavedHosts,
  needsLocalHostStart,
  normalizeHostOrigin,
  parseLegacyHost,
  parseSavedHosts,
  removeSavedHost,
  renameSavedHost,
  sameHostAddress,
  SAVED_HOSTS_KEY,
  toHostAddress,
  upsertSavedHost,
} from "../src/app/saved-hosts";

function memoryStorage(initial: Record<string, string> = {}): HostStorage & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

test("normalizes origins, display names, and address equality", () => {
  expect(normalizeHostOrigin("  HTTP://Example.COM:80/  ")).toBe(
    "http://example.com",
  );
  expect(normalizeHostOrigin("wss://vps.example.com/ws")).toBe(
    "https://vps.example.com",
  );
  expect(normalizeHostOrigin("192.168.1.5:8787")).toBe(
    "http://192.168.1.5:8787",
  );
  expect(normalizeHostOrigin("not a url/with/path")).toBe(null);
  expect(normalizeHostOrigin("")).toBe(null);

  expect(hostOriginLabel("https://vps.example.com")).toBe("vps.example.com");
  expect(hostOriginLabel("http://192.168.1.5:8787")).toBe("192.168.1.5:8787");
  expect(
    hostDisplayName({ origin: "https://vps.example.com", name: "  Prod  " }),
  ).toBe("Prod");
  expect(hostDisplayName({ origin: "https://vps.example.com" })).toBe(
    "vps.example.com",
  );

  expect(
    sameHostAddress(
      { origin: "http://127.0.0.1:8787/", token: " abc " },
      { origin: "127.0.0.1:8787", token: "abc" },
    ),
  ).toBe(true);
  expect(
    sameHostAddress(
      { origin: "http://127.0.0.1:8787", token: "abc" },
      { origin: "http://127.0.0.1:8787", token: "xyz" },
    ),
  ).toBe(false);
  expect(
    sameHostAddress(
      { origin: "http://127.0.0.1:8787", local: true },
      { origin: "http://127.0.0.1:8787" },
    ),
  ).toBe(false);
});

test("defensively parses corrupt storage and deduplicates + sorts entries", () => {
  expect(parseSavedHosts(null)).toEqual([]);
  expect(parseSavedHosts("{invalid json")).toEqual([]);
  expect(parseSavedHosts(JSON.stringify({ origin: "http://a.test" }))).toEqual(
    [],
  );
  expect(parseLegacyHost("{bad")).toBe(null);
  expect(parseLegacyHost(JSON.stringify({ origin: "ftp://bad" }))).toBe(null);

  const raw = JSON.stringify([
    null,
    42,
    { origin: "ftp://invalid.example" },
    { origin: "http://b.example:8787", lastConnectedAt: 100 },
    {
      origin: "HTTP://A.EXAMPLE:8787/",
      name: "Alpha",
      token: "old",
      lastConnectedAt: 50,
    },
    {
      origin: "http://a.example:8787",
      token: "new",
      lastConnectedAt: 200,
    },
    {
      origin: "https://c.example",
      lastConnectedAt: -5,
    },
  ]);
  expect(parseSavedHosts(raw)).toEqual([
    {
      origin: "http://a.example:8787",
      name: "Alpha",
      token: "new",
      lastConnectedAt: 200,
    },
    {
      origin: "http://b.example:8787",
      lastConnectedAt: 100,
    },
    {
      origin: "https://c.example",
      lastConnectedAt: 0,
    },
  ]);
});

test("migrates legacy single eta.host without duplicating existing entries", () => {
  const migrated = migrateSavedHosts(
    null,
    JSON.stringify({ origin: "https://vps.example.com/", token: "tok1" }),
    1_700_000_000_000,
  );
  expect(migrated.migrated).toBe(true);
  expect(migrated.active).toEqual({
    origin: "https://vps.example.com",
    token: "tok1",
  });
  expect(migrated.hosts).toEqual([
    {
      origin: "https://vps.example.com",
      token: "tok1",
      lastConnectedAt: 1_700_000_000_000,
    },
  ]);

  const existing: SavedHost[] = [
    {
      origin: "https://vps.example.com",
      name: "Prod VPS",
      token: "tok1",
      lastConnectedAt: 500,
    },
  ];
  const alreadyPresent = migrateSavedHosts(
    JSON.stringify(existing),
    JSON.stringify({ origin: "https://vps.example.com", token: "tok1" }),
    999,
  );
  expect(alreadyPresent.migrated).toBe(false);
  expect(alreadyPresent.hosts).toEqual(existing);
  expect(alreadyPresent.active).toEqual({
    origin: "https://vps.example.com",
    token: "tok1",
  });

  const withoutLegacy = migrateSavedHosts(JSON.stringify(existing), null, 999);
  expect(withoutLegacy.migrated).toBe(false);
  expect(withoutLegacy.active).toEqual(toHostAddress(existing[0]!));
});

test("upsert preserves custom alias, updates recency, rename and remove work cleanly", () => {
  const first = upsertSavedHost(
    [],
    { origin: "https://a.example", token: "t1" },
    { name: "Office", now: 100 },
  );
  const second = upsertSavedHost(
    first,
    { origin: "https://b.example" },
    { now: 200 },
  );
  expect(second.map((item) => item.origin)).toEqual([
    "https://b.example",
    "https://a.example",
  ]);

  // Reconnecting to A preserves its custom alias "Office" and bumps it to the top.
  const reconnected = upsertSavedHost(
    second,
    { origin: "HTTPS://A.EXAMPLE/", token: "t2" },
    { now: 300 },
  );
  expect(reconnected).toEqual([
    {
      origin: "https://a.example",
      name: "Office",
      token: "t2",
      lastConnectedAt: 300,
    },
    {
      origin: "https://b.example",
      lastConnectedAt: 200,
    },
  ]);

  const renamed = renameSavedHost(reconnected, "https://b.example", "Staging");
  expect(renamed[1]).toEqual({
    origin: "https://b.example",
    name: "Staging",
    lastConnectedAt: 200,
  });

  // Clearing alias falls back cleanly to unnamed entry.
  const cleared = renameSavedHost(renamed, "https://a.example", "   ");
  expect(cleared[0]).toEqual({
    origin: "https://a.example",
    token: "t2",
    lastConnectedAt: 300,
  });

  const removed = removeSavedHost(cleared, "https://a.example");
  expect(removed).toEqual([
    {
      origin: "https://b.example",
      name: "Staging",
      lastConnectedAt: 200,
    },
  ]);
});

test("createSavedHosts migrates legacy storage and keeps eta.host synced", async () => {
  let clock = 1000;
  const storage = memoryStorage({
    [LEGACY_HOST_KEY]: JSON.stringify({
      origin: "https://legacy.example",
      token: "old-token",
    }),
  });
  const store = createSavedHosts({ storage, now: () => ++clock });
  const startup = await store.load();
  expect(startup).toEqual({
    origin: "https://legacy.example",
    token: "old-token",
  });
  expect(store.hosts().length).toBe(1);
  expect(parseSavedHosts(storage.data.get(SAVED_HOSTS_KEY))).toEqual([
    {
      origin: "https://legacy.example",
      token: "old-token",
      lastConnectedAt: 1001,
    },
  ]);

  store.rename("https://legacy.example", "Home Box");
  expect(store.displayName("https://legacy.example")).toBe("Home Box");

  store.remember({ origin: "https://vps.example", token: "vps-token" });
  expect(parseLegacyHost(storage.data.get(LEGACY_HOST_KEY))).toEqual({
    origin: "https://vps.example",
    token: "vps-token",
  });
  expect(store.hosts().map((item) => item.origin)).toEqual([
    "https://vps.example",
    "https://legacy.example",
  ]);

  // Removing the currently synced host rotates legacy eta.host to the remaining saved host.
  store.remove("https://vps.example");
  expect(parseLegacyHost(storage.data.get(LEGACY_HOST_KEY))).toEqual({
    origin: "https://legacy.example",
    token: "old-token",
  });

  // Removing the last saved host clears legacy eta.host.
  store.remove("https://legacy.example");
  expect(storage.data.has(LEGACY_HOST_KEY)).toBe(false);
  expect(store.hosts()).toEqual([]);
});

test("createSavedHosts preserves stored custom alias if remember runs before load settles", async () => {
  const storage = memoryStorage({
    [SAVED_HOSTS_KEY]: JSON.stringify([
      {
        origin: "http://127.0.0.1:8787",
        name: "Local Dev",
        lastConnectedAt: 100,
      },
      {
        origin: "https://remote.example",
        name: "Remote VPS",
        lastConnectedAt: 50,
      },
    ]),
  });
  const store = createSavedHosts({ storage, now: () => 500 });
  const pending = store.load();
  // Fast loopback connection remembers before async storage read resolves.
  store.remember({ origin: "http://127.0.0.1:8787", local: true });
  await pending;

  expect(store.hosts()).toEqual([
    {
      origin: "http://127.0.0.1:8787",
      name: "Local Dev",
      local: true,
      lastConnectedAt: 500,
    },
    {
      origin: "https://remote.example",
      name: "Remote VPS",
      lastConnectedAt: 50,
    },
  ]);
});

test("upsertSavedHost replaces ephemeral local host port while preserving alias and needsLocalHostStart decides resume", () => {
  const initial: SavedHost[] = [
    {
      origin: "http://127.0.0.1:51111",
      name: "My Mac",
      token: "old-tok",
      local: true,
      lastConnectedAt: 100,
    },
    {
      origin: "https://vps.example",
      name: "Prod VPS",
      lastConnectedAt: 200,
    },
  ];
  const restarted = upsertSavedHost(
    initial,
    { origin: "http://127.0.0.1:54321", token: "new-tok", local: true },
    { now: 300 },
  );
  expect(restarted).toEqual([
    {
      origin: "http://127.0.0.1:54321",
      name: "My Mac",
      token: "new-tok",
      local: true,
      lastConnectedAt: 300,
    },
    {
      origin: "https://vps.example",
      name: "Prod VPS",
      lastConnectedAt: 200,
    },
  ]);

  expect(
    needsLocalHostStart({
      address: { origin: "http://127.0.0.1:51111", local: true },
      activeOrigin: "https://vps.example",
      activeOpen: true,
      canStartHost: true,
    }),
  ).toBe(true);
  expect(
    needsLocalHostStart({
      address: { origin: "http://127.0.0.1:54321", local: true },
      activeOrigin: "http://127.0.0.1:54321/",
      activeOpen: true,
      canStartHost: true,
    }),
  ).toBe(false);
  expect(
    needsLocalHostStart({
      address: { origin: "http://127.0.0.1:54321", local: true },
      activeOrigin: "http://127.0.0.1:54321",
      activeOpen: false,
      canStartHost: true,
    }),
  ).toBe(true);
  expect(
    needsLocalHostStart({
      address: { origin: "http://127.0.0.1:54321", local: true },
      activeOrigin: "https://vps.example",
      activeOpen: true,
      canStartHost: false,
    }),
  ).toBe(false);
  expect(
    needsLocalHostStart({
      address: { origin: "https://vps.example" },
      activeOrigin: "http://127.0.0.1:54321",
      activeOpen: true,
      canStartHost: true,
    }),
  ).toBe(false);
});
