/**
 * Which `plugins` ops ask the transport to run them out of order (OpMeta.unordered): read-only
 * lookups that may wait on the network and that no earlier call of the connection has to come
 * before. Everything else stays in arrival order, which is the default.
 */
import { describe, expect, it } from "vitest";
import { pluginsPlugin } from "../src/plugins/plugin";

/** The ops the plugin registers, with the meta each was registered with. */
function registered() {
  const ops = new Map<string, { unordered?: boolean } | undefined>();
  const wire = new Proxy(
    {
      handle: (
        target: string,
        action: string,
        _run: never,
        meta?: { unordered?: boolean },
      ) => {
        ops.set(`${target}.${action}`, meta);
        return () => {};
      },
    } as Record<string, unknown>,
    { get: (self, key: string) => self[key] ?? (() => () => {}) },
  );
  pluginsPlugin(
    { plugins: {} as never, agents: {} as never, market: {} as never },
    () => {},
  ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
  return ops;
}

const UNORDERED = [
  "plugins.logo",
  "plugins.logosCached",
  "plugins.marketCatalog",
  "plugins.marketPreview",
  // Only reads the sources and the proxy the host keeps; no write of the connection has to come before it.
  "plugins.marketSettings",
  // Only says whether a key is set and whether the source is on; both are the host's own state.
  "plugins.composioStatus",
];

/** Each of these writes something, or needs an earlier call of the connection to have landed. */
const IN_LINE = [
  "plugins.testServer",
  "plugins.loginServer",
  "plugins.logoutServer",
  "plugins.marketAddSource",
  "plugins.marketRemoveSource",
  "plugins.marketSetSourceEnabled",
  "plugins.marketSetProxy",
  "plugins.marketClearCache",
  "plugins.marketInstall",
  "plugins.setHeaders",
  "plugins.setEnabled",
  "plugins.add",
  "plugins.remove",
  "plugins.recheck",
];

describe("the plugins ops that run out of order", () => {
  it.each(UNORDERED)("%s is registered unordered", (name) => {
    const ops = registered();
    expect(ops.has(name)).toBe(true);
    expect(ops.get(name)?.unordered).toBe(true);
  });

  it.each(IN_LINE)("%s stays in arrival order", (name) => {
    const ops = registered();
    expect(ops.has(name)).toBe(true);
    expect(ops.get(name)?.unordered).not.toBe(true);
  });

  it("marks no other op", () => {
    const marked = [...registered()]
      .filter(([, meta]) => meta?.unordered === true)
      .map(([name]) => name)
      .sort();
    expect(marked).toEqual([...UNORDERED].sort());
  });
});
