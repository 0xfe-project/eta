import type * as vm from "node:vm";
import type { Linker, Realm } from "./realm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { $ } from "zx";

/**
 * The `node:*` half of a realm's surface, in two layers with different rules.
 *
 * **Curated layer**: `node:fs`, `node:fs/promises`, `node:path`, `node:url`,
 * and `randomUUID` in `node:crypto`. Two rules hold here, and both are about
 * the seam rather than about safety:
 *
 * - Every function goes through {@link Realm.binding}, so a call is recorded
 *   with the line that made it.
 * - Everything that comes back is a plain value. A host `Buffer` would carry
 *   the host's prototype into the realm, where `instanceof Uint8Array` would
 *   then answer wrongly.
 *
 * Whether a curated call is allowed is not decided here. Each binding asks the
 * authorizer the host installed at {@link RealmOptions.authorize}; this file
 * only makes sure there is no way around the question.
 *
 * **Passthrough layer**: the modules in {@link PASSTHROUGH}. These are the
 * host's own module objects, mounted as they are, and neither rule applies:
 *
 * - Calls are not bindings. A socket opened with `node:net`, a hash taken with
 *   `node:crypto`, a request made with `node:https` leave no row in the effect
 *   ledger and are never put to the authorizer. This widens the gap ESMMODE §1
 *   already names for `$` (see {@link mountShell}): a script that can run `$`
 *   could already open any connection, so this is no new reach, only less
 *   visibility. No second ledger is kept for it.
 * - Values keep the host's prototypes. The same object reference is mounted,
 *   so the `Buffer` global from {@link mountNodeGlobals} is `node:buffer`'s
 *   `Buffer`, the `EventEmitter` a socket extends is `node:events`'s, and
 *   `instanceof` between them answers right. What does not hold is identity
 *   with the realm's own intrinsics: a host `Buffer` is not `instanceof` the
 *   realm's `Uint8Array`.
 *
 * `node:child_process` is left out on purpose: `$` is the realm's way to run a
 * process, and a second one would only be a second hole. A built-in in neither
 * layer fails as "not mounted"; it is never installed from npm.
 */
/**
 * Built-ins mounted as the host's own module objects; see {@link mountNodeModules}
 * for what that gives up. `node:diagnostics_channel` is here because postgres
 * imports it; the subpaths are parts of modules already on the list.
 */
export const PASSTHROUGH: readonly string[] = [
  "node:assert",
  "node:assert/strict",
  "node:async_hooks",
  "node:buffer",
  "node:crypto",
  "node:diagnostics_channel",
  "node:dns",
  "node:dns/promises",
  "node:events",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:querystring",
  "node:stream",
  "node:stream/promises",
  "node:stream/web",
  "node:string_decoder",
  "node:timers",
  "node:timers/promises",
  "node:tls",
  "node:util",
  "node:util/types",
  "node:zlib",
];

const hostRequire = createRequire(import.meta.url);

export function mountNodeModules(realm: Realm, cwd?: string): Linker {
  const cache = new Map<string, unknown>();

  return (specifier) => {
    const cached = cache.get(specifier);
    if (cached !== undefined) return cached as ReturnType<Linker>;
    const module = nodeModule(realm, specifier, cwd);
    if (module !== undefined) cache.set(specifier, module);
    return module as ReturnType<Linker>;
  };
}

/**
 * A curated module answers `import fs from "node:fs"` the way Node's CJS
 * interop does: the whole namespace, as the default. A package written as
 * ESM-with-default-imports (postgres does `import fs from 'fs'`) links
 * against the curated layer only if the default is there.
 */
function syntheticWithDefault(
  realm: Realm,
  specifier: string,
  exports: Record<string, unknown>,
): vm.Module {
  return realm.synthetic(specifier, { ...exports, default: exports });
}

function nodeModule(realm: Realm, specifier: string, cwd?: string) {
  // A relative path means the session's working directory, not the host process's.
  const at = (p: string): string => path.resolve(cwd ?? process.cwd(), p);
  switch (specifier) {
    case "node:fs/promises":
      return syntheticWithDefault(realm, specifier, {
        readFile: realm.binding(
          "fs.readFile",
          async (path: string, encoding = "utf8") =>
            fsp.readFile(at(path), encoding as BufferEncoding),
        ),
        writeFile: realm.binding(
          "fs.writeFile",
          async (path: string, data: string) => {
            await fsp.writeFile(at(path), data, "utf8");
            return data.length;
          },
        ),
        appendFile: realm.binding(
          "fs.appendFile",
          async (path: string, data: string) =>
            fsp.appendFile(at(path), data, "utf8"),
        ),
        mkdir: realm.binding("fs.mkdir", async (path: string) =>
          fsp.mkdir(at(path), { recursive: true }),
        ),
        readdir: realm.binding("fs.readdir", async (path: string) =>
          fsp.readdir(at(path)),
        ),
        stat: realm.binding("fs.stat", async (path: string) => {
          const stat = await fsp.stat(at(path));
          return {
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            mtimeMs: stat.mtimeMs,
          };
        }),
        rm: realm.binding("fs.rm", async (path: string) =>
          fsp.rm(at(path), { recursive: true, force: true }),
        ),
        rename: realm.binding("fs.rename", async (from: string, to: string) =>
          fsp.rename(at(from), at(to)),
        ),
        copyFile: realm.binding(
          "fs.copyFile",
          async (from: string, to: string) => fsp.copyFile(at(from), at(to)),
        ),
        realpath: realm.binding("fs.realpath", async (path: string) =>
          fsp.realpath(at(path)),
        ),
      });
    case "node:fs":
      return syntheticWithDefault(realm, specifier, {
        readFileSync: realm.binding(
          "fs.readFileSync",
          (path: string, encoding = "utf8") =>
            fs.readFileSync(at(path), encoding as BufferEncoding),
        ),
        writeFileSync: realm.binding(
          "fs.writeFileSync",
          (path: string, data: string) => {
            fs.writeFileSync(at(path), data, "utf8");
            return data.length;
          },
        ),
        existsSync: realm.binding("fs.existsSync", (path: string) =>
          fs.existsSync(at(path)),
        ),
        readdirSync: realm.binding("fs.readdirSync", (path: string) =>
          fs.readdirSync(at(path)),
        ),
        mkdirSync: realm.binding("fs.mkdirSync", (path: string) =>
          fs.mkdirSync(at(path), { recursive: true }),
        ),
        statSync: realm.binding("fs.statSync", (path: string) => {
          const stat = fs.statSync(at(path));
          return {
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            mtimeMs: stat.mtimeMs,
          };
        }),
        rmSync: realm.binding("fs.rmSync", (path: string) =>
          fs.rmSync(at(path), { recursive: true, force: true }),
        ),
        appendFileSync: realm.binding(
          "fs.appendFileSync",
          (path: string, data: string) =>
            fs.appendFileSync(at(path), data, "utf8"),
        ),
        realpathSync: realm.binding("fs.realpathSync", (path: string) =>
          fs.realpathSync(at(path)),
        ),
      });
    case "node:path":
      return syntheticWithDefault(realm, specifier, {
        join: realm.binding("path.join", (...parts: string[]) =>
          path.join(...parts),
        ),
        resolve: realm.binding("path.resolve", (...parts: string[]) =>
          path.resolve(cwd ?? process.cwd(), ...parts),
        ),
        relative: realm.binding("path.relative", (from: string, to: string) =>
          path.relative(from, to),
        ),
        basename: realm.binding("path.basename", (value: string) =>
          path.basename(value),
        ),
        dirname: realm.binding("path.dirname", (value: string) =>
          path.dirname(value),
        ),
        extname: realm.binding("path.extname", (value: string) =>
          path.extname(value),
        ),
        isAbsolute: realm.binding("path.isAbsolute", (value: string) =>
          path.isAbsolute(value),
        ),
        sep: path.sep,
      });
    case "node:url":
      return syntheticWithDefault(realm, specifier, {
        fileURLToPath: realm.binding("url.fileURLToPath", (value: string) =>
          fileURLToPath(value),
        ),
        pathToFileURL: realm.binding(
          "url.pathToFileURL",
          (value: string) => pathToFileURL(value).href,
        ),
      });
    case "node:crypto":
      // Passthrough, with randomUUID kept the binding it was.
      return passthrough(realm, specifier, {
        randomUUID: realm.binding("crypto.randomUUID", () => randomUUID()),
      });
    default:
      return PASSTHROUGH.includes(specifier)
        ? passthrough(realm, specifier)
        : undefined;
  }
}

/**
 * The host module as it is: the same object a host `import` gets, as the
 * default export and spread into named exports. `overrides` replaces names in
 * both, without touching the host module.
 */
function passthrough(
  realm: Realm,
  specifier: string,
  overrides: Record<string, unknown> = {},
): vm.Module {
  const host = hostRequire(specifier) as Record<string, unknown>;
  const value =
    Object.keys(overrides).length === 0
      ? host
      : Object.assign(Object.create(host) as object, overrides);
  return realm.synthetic(specifier, { ...host, ...overrides, default: value });
}

/**
 * The Node globals a package expects without importing anything. They belong
 * to the passthrough layer and share its terms: host objects, no ledger row, no
 * authorizer. `Buffer` is `node:buffer`'s `Buffer`, so a package's
 * `Buffer.isBuffer` and the buffers `node:net` hands it agree. `process`
 * includes `process.env`, which `$` already reaches.
 *
 * `setTimeout` and `clearTimeout` are not here: {@link mountGlobals} keeps them
 * as bindings, as before.
 */
export function mountNodeGlobals(realm: Realm): void {
  const host = globalThis as unknown as Record<string, unknown>;
  for (const name of [
    "Buffer",
    "process",
    "performance",
    "queueMicrotask",
    "setImmediate",
    "clearImmediate",
    "setInterval",
    "clearInterval",
    "URL",
    "URLSearchParams",
    "TextEncoder",
    "TextDecoder",
  ]) {
    if (name in host) realm.global(name, host[name]);
  }
}

/**
 * `$`, from the lite build of zx.
 *
 * The dependency is `zx@lite` — a separate published version (`8.8.5-lite`),
 * not a subpath of the full package: its `.` export is the core build, 130 KB
 * against 880 KB. What it exports is what a shell is for, so nothing is
 * wrapped and nothing is renamed; `$` is mounted as `$`.
 *
 * Worth stating what this does not do. A command's own reads, writes and
 * outbound calls happen on the far side of the seam, so none of them are
 * effects and none of them can be authorised. The ledger says a command ran
 * and nothing about what was inside it — the gap ESMMODE §1 already names.
 */
export function mountShell(realm: Realm, cwd?: string): void {
  // Commands run in the session's working directory; `$.cwd` is not changed for the host.
  const shell = cwd === undefined ? $ : $({ cwd });
  const tag = realm.wrap(
    shell as unknown as (...args: unknown[]) => unknown,
  ) as unknown as Record<string, unknown>;
  // `$.nothrow()` and friends are properties on the function itself; without
  // them the shell is there but every failure is fatal.
  for (const [key, value] of Object.entries(
    $ as unknown as Record<string, unknown>,
  )) {
    if (typeof value === "function")
      tag[key] = realm.wrap(value as (...args: unknown[]) => unknown);
  }
  realm.global("$", tag as unknown as (...args: unknown[]) => unknown);
}

/**
 * Globals a script expects to exist without importing anything.
 *
 * `fetch` is the one that matters: it is the outbound edge, so it is a binding
 * like the rest and an outbound call shows up in the effect list with the line
 * that made it.
 */
export function mountGlobals(realm: Realm): void {
  realm.global(
    "fetch",
    realm.binding(
      "fetch",
      async (
        url: string,
        init?: {
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        },
      ) => {
        const response = await fetch(url, init as RequestInit);
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          text: async () => text,
          json: async () => JSON.parse(text) as unknown,
        };
      },
    ),
  );

  const timers = realm.binding("setTimeout", (fn: () => void, ms?: number) =>
    setTimeout(fn, ms),
  );
  realm.global("setTimeout", timers);
  realm.global(
    "clearTimeout",
    realm.binding("clearTimeout", (handle: unknown) =>
      clearTimeout(handle as NodeJS.Timeout),
    ),
  );
}
