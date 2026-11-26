import type { WindowsShellProbe } from "@eta/ssh";
import type * as vm from "node:vm";
import type { Linker, Realm } from "./realm";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";

import * as path from "node:path";
import process from "node:process";

import { fileURLToPath, pathToFileURL } from "node:url";
import { localWindowsProbe, windowsChildEnv, windowsShell } from "@eta/ssh";
import { $, quote } from "zx";

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
 * against 880 KB.
 *
 * Each command is wrapped per-realm so it:
 * - inherits the active evaluation's `AbortSignal` combined with the realm's
 *   disposal `AbortSignal` (unless the caller passed an explicit `signal`/`ac`);
 * - runs in its own process group on Unix (`detached: true`) so both abort and
 *   `.timeout()` kill grandchildren and close pipes promptly;
 * - records a `$` effect in the active `EffectScope` with callsite & command.
 */
const SHELL_OPTION_KEYS = [
  "nothrow",
  "quiet",
  "verbose",
  "cwd",
  "env",
  "prefix",
  "postfix",
  "shell",
  "timeout",
  "timeoutSignal",
  "killSignal",
  "stdio",
  "detached",
  "preferLocal",
  "delimiter",
] as const;

function summarizeShellCommand(cmd: string): string {
  const normalized = cmd.trim().replace(/\s+/g, " ");
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function renderShellCommand(
  pieces: TemplateStringsArray,
  args: readonly unknown[],
): string {
  const quoteFn = $.quote ?? quote;
  try {
    let out = pieces[0] ?? "";
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const formatValue = (value: unknown): string => {
        if (
          value !== null &&
          (typeof value === "object" || typeof value === "function") &&
          typeof (value as { then?: unknown }).then === "function"
        ) {
          return "<pending>";
        }
        const str =
          value !== null &&
          typeof value === "object" &&
          typeof (value as { stdout?: unknown }).stdout === "string"
            ? (value as { stdout: string }).stdout.replace(/\n$/, "")
            : String(value);
        return quoteFn(str);
      };
      const rendered = Array.isArray(arg)
        ? arg.map(formatValue).join(" ")
        : formatValue(arg);
      out += rendered + (pieces[i + 1] ?? "");
    }
    return out;
  } catch {
    return pieces.join(" ");
  }
}

export function mountShell(
  realm: Realm,
  cwd?: string,
  getSignal?: () => AbortSignal | undefined,
): void {
  if (process.platform === "win32") selectGitBash();
  // Commands run in the session's working directory; `$.cwd` is not changed for the host.
  const realmDefaults: Record<string, unknown> =
    cwd === undefined ? {} : { cwd };

  const wrapShell = (
    extraOptions: Record<string, unknown>,
  ): ((...args: unknown[]) => unknown) =>
    realm.wrap((first: unknown, ...rest: unknown[]): unknown => {
      if (!Array.isArray(first)) {
        const nextOptions =
          first !== null && typeof first === "object"
            ? { ...extraOptions, ...(first as Record<string, unknown>) }
            : extraOptions;
        return wrapShell(nextOptions);
      }

      const pieces = first as unknown as TemplateStringsArray;
      const merged: Record<string, unknown> = {
        detached: process.platform !== "win32",
        ...realmDefaults,
        ...extraOptions,
      };
      const hasCustomSignal =
        merged.signal !== undefined || merged.ac !== undefined;
      const evalSignal = getSignal?.();
      const combinedSignal = hasCustomSignal
        ? (merged.signal as AbortSignal | undefined)
        : evalSignal === undefined
          ? realm.signal
          : AbortSignal.any([realm.signal, evalSignal]);
      const effectiveOpts: Record<string, unknown> = hasCustomSignal
        ? merged
        : { ...merged, signal: combinedSignal };

      const initialDetail = summarizeShellCommand(
        renderShellCommand(pieces, rest),
      );
      const finish = realm.trackCall("$", initialDetail);
      if (realm.killed) {
        finish("blocked", "the realm was killed");
        throw new Error("$ was refused: the realm was killed");
      }

      const invokeShell = $ as unknown as (
        opts: Record<string, unknown>,
      ) => (p: TemplateStringsArray, ...a: unknown[]) => unknown;
      let result: unknown;
      try {
        result = invokeShell(effectiveOpts)(pieces, ...rest);
      } catch (error) {
        const aborted =
          (effectiveOpts.signal as AbortSignal | undefined)?.aborted === true;
        finish(aborted ? "aborted" : "failed", initialDetail);
        throw error;
      }

      const finalDetail = (): string => {
        const cmd = (result as { cmd?: unknown } | undefined)?.cmd;
        return typeof cmd === "string"
          ? summarizeShellCommand(cmd)
          : initialDetail;
      };
      const isAborted = (): boolean => {
        const ppSignal = (result as { signal?: unknown } | undefined)?.signal;
        const sig = (
          ppSignal !== null &&
          typeof ppSignal === "object" &&
          "aborted" in ppSignal
            ? ppSignal
            : effectiveOpts.signal
        ) as AbortSignal | undefined;
        return sig?.aborted === true;
      };

      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        void (result as Promise<{ ok?: boolean }>).then(
          (out) => {
            if (isAborted()) {
              finish("aborted", finalDetail());
            } else if (
              out !== null &&
              typeof out === "object" &&
              out.ok === false
            ) {
              finish("failed", finalDetail());
            } else {
              finish("ok", finalDetail());
            }
          },
          () => {
            finish(isAborted() ? "aborted" : "failed", finalDetail());
          },
        );
        return result;
      }

      const syncOk =
        result === null ||
        typeof result !== "object" ||
        (result as { ok?: boolean }).ok !== false;
      finish(isAborted() ? "aborted" : syncOk ? "ok" : "failed", finalDetail());
      return result;
    });

  const tag = wrapShell({}) as ((...args: unknown[]) => unknown) &
    Record<string, unknown>;
  tag.sync = wrapShell({ sync: true });
  tag.kill = realm.wrap((...args: Parameters<typeof $.kill>) =>
    $.kill(...args),
  );
  tag.quote = realm.wrap((arg: string) => ($.quote ?? quote)(arg));
  const rawDollar = $ as unknown as Record<string, unknown>;
  for (const key of SHELL_OPTION_KEYS) {
    Object.defineProperty(tag, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        if (Object.hasOwn(realmDefaults, key)) return realmDefaults[key];
        if (key === "detached") return process.platform !== "win32";
        return rawDollar[key];
      },
      set: (value: unknown) => {
        realmDefaults[key] = value;
      },
    });
  }
  realm.global("$", tag);
}

/**
 * Git Bash for `$` on Windows, and the PATH its Unix tools need.
 *
 * zx runs `bash` from PATH, and on Windows that is `System32\bash.exe`: WSL, which has none of the
 * host's programs, eats backslashes in paths and does not see the Windows environment. The probe is
 * the one `LocalTransport` uses, so there is a single answer to "where is Git's shell". It throws when
 * there is none; falling back to WSL would make every command quietly run on another machine.
 */
export function gitBashSetup(probe: WindowsShellProbe): {
  shell: string;
  env: { PATH: string };
} {
  const sh = windowsShell(probe);
  const bash = sh.replace(/[\\/]sh\.exe$/i, (sep) => `${sep[0]}bash.exe`);
  const shell = bash !== sh && probe.exists(bash) ? bash : sh;
  return { shell, env: windowsChildEnv(shell, probe.env.PATH) };
}

function selectGitBash(): void {
  const bash = gitBashSetup(localWindowsProbe);
  $.shell = bash.shell;
  $.prefix = "set -euo pipefail;";
  $.quote = quote;
  $.env = { ...process.env, ...bash.env };
}

/**
 * Globals a script expects to exist without importing anything.
 *
 * `fetch` is the one that matters: it is the outbound edge, so it is a binding
 * like the rest and an outbound call shows up in the effect list with the line
 * that made it.
 */
export function mountGlobals(
  realm: Realm,
  getSignal?: () => AbortSignal | undefined,
): void {
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
          signal?: AbortSignal;
        },
      ) => {
        const signals = [realm.signal, getSignal?.(), init?.signal].filter(
          (s): s is AbortSignal => s !== undefined,
        );
        const signal =
          signals.length === 0
            ? undefined
            : signals.length === 1
              ? signals[0]
              : AbortSignal.any(signals);
        const response = await fetch(url, {
          ...(init === undefined ? {} : (init as RequestInit)),
          ...(signal === undefined ? {} : { signal }),
        });
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
