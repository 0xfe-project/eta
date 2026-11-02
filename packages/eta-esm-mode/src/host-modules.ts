import type { Linker, Realm } from "./realm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { fileURLToPath, pathToFileURL } from "node:url";

import { $ } from "zx";

/**
 * The `node:*` half of a realm's surface.
 *
 * Two rules hold for everything here, and both are about the seam rather than
 * about safety:
 *
 * - Every function goes through {@link Realm.binding}, so a call is recorded
 *   with the line that made it. Nothing reaches the host any other way.
 * - Everything that comes back is a plain value. A host `Buffer` would carry
 *   the host's prototype into the realm, where `instanceof Uint8Array` would
 *   then answer wrongly.
 *
 * Whether a call is allowed is not decided here. Each binding asks the
 * authorizer the host installed at {@link RealmOptions.authorize}; this file
 * only makes sure there is no way around the question.
 */
export function mountNodeModules(realm: Realm): Linker {
  const cache = new Map<string, unknown>();

  return (specifier) => {
    const cached = cache.get(specifier);
    if (cached !== undefined) return cached as ReturnType<Linker>;
    const module = nodeModule(realm, specifier);
    if (module !== undefined) cache.set(specifier, module);
    return module as ReturnType<Linker>;
  };
}

function nodeModule(realm: Realm, specifier: string) {
  switch (specifier) {
    case "node:fs/promises":
      return realm.synthetic(specifier, {
        readFile: realm.binding(
          "fs.readFile",
          async (path: string, encoding = "utf8") =>
            fsp.readFile(path, encoding as BufferEncoding),
        ),
        writeFile: realm.binding(
          "fs.writeFile",
          async (path: string, data: string) => {
            await fsp.writeFile(path, data, "utf8");
            return data.length;
          },
        ),
        appendFile: realm.binding(
          "fs.appendFile",
          async (path: string, data: string) =>
            fsp.appendFile(path, data, "utf8"),
        ),
        mkdir: realm.binding("fs.mkdir", async (path: string) =>
          fsp.mkdir(path, { recursive: true }),
        ),
        readdir: realm.binding("fs.readdir", async (path: string) =>
          fsp.readdir(path),
        ),
        stat: realm.binding("fs.stat", async (path: string) => {
          const stat = await fsp.stat(path);
          return {
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            mtimeMs: stat.mtimeMs,
          };
        }),
        rm: realm.binding("fs.rm", async (path: string) =>
          fsp.rm(path, { recursive: true, force: true }),
        ),
        rename: realm.binding("fs.rename", async (from: string, to: string) =>
          fsp.rename(from, to),
        ),
        copyFile: realm.binding(
          "fs.copyFile",
          async (from: string, to: string) => fsp.copyFile(from, to),
        ),
        realpath: realm.binding("fs.realpath", async (path: string) =>
          fsp.realpath(path),
        ),
      });
    case "node:fs":
      return realm.synthetic(specifier, {
        readFileSync: realm.binding(
          "fs.readFileSync",
          (path: string, encoding = "utf8") =>
            fs.readFileSync(path, encoding as BufferEncoding),
        ),
        writeFileSync: realm.binding(
          "fs.writeFileSync",
          (path: string, data: string) => {
            fs.writeFileSync(path, data, "utf8");
            return data.length;
          },
        ),
        existsSync: realm.binding("fs.existsSync", (path: string) =>
          fs.existsSync(path),
        ),
        readdirSync: realm.binding("fs.readdirSync", (path: string) =>
          fs.readdirSync(path),
        ),
        mkdirSync: realm.binding("fs.mkdirSync", (path: string) =>
          fs.mkdirSync(path, { recursive: true }),
        ),
        statSync: realm.binding("fs.statSync", (path: string) => {
          const stat = fs.statSync(path);
          return {
            size: stat.size,
            isFile: stat.isFile(),
            isDirectory: stat.isDirectory(),
            mtimeMs: stat.mtimeMs,
          };
        }),
        rmSync: realm.binding("fs.rmSync", (path: string) =>
          fs.rmSync(path, { recursive: true, force: true }),
        ),
        appendFileSync: realm.binding(
          "fs.appendFileSync",
          (path: string, data: string) => fs.appendFileSync(path, data, "utf8"),
        ),
        realpathSync: realm.binding("fs.realpathSync", (path: string) =>
          fs.realpathSync(path),
        ),
      });
    case "node:path":
      return realm.synthetic(specifier, {
        join: realm.binding("path.join", (...parts: string[]) =>
          path.join(...parts),
        ),
        resolve: realm.binding("path.resolve", (...parts: string[]) =>
          path.resolve(...parts),
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
      return realm.synthetic(specifier, {
        fileURLToPath: realm.binding("url.fileURLToPath", (value: string) =>
          fileURLToPath(value),
        ),
        pathToFileURL: realm.binding(
          "url.pathToFileURL",
          (value: string) => pathToFileURL(value).href,
        ),
      });
    case "node:crypto":
      return realm.synthetic(specifier, {
        randomUUID: realm.binding("crypto.randomUUID", () => randomUUID()),
      });
    default:
      return undefined;
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
export function mountShell(realm: Realm): void {
  const tag = realm.wrap(
    $ as unknown as (...args: unknown[]) => unknown,
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
