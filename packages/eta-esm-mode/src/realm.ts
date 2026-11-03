import process from "node:process";
import * as vm from "node:vm";

/**
 * One binding call, as the host saw it.
 *
 * `at` is the place in the module source that made the call — the thing that
 * turns "a write happened" into "line 12 wrote it".
 */
export interface Effect {
  /** Full binding name, e.g. `fs.writeFile` or `fetch`. */
  name: string;
  /** Where in the source the call was made. */
  at: { identifier: string; line: number; column: number };
  status: "ok" | "failed" | "blocked";
  ms: number;
  /** One short line: the path, the URL, the error message. */
  detail: string;
}

export interface AuthorizationRequest {
  /** Full binding name, e.g. `fs.readFile` or `fetch`. */
  name: string;
  /** The arguments as they were passed, before any coercion. */
  input: readonly unknown[];
  /** Where in the source the call was made. */
  at: Effect["at"];
}

/**
 * Decides whether one binding call may reach the host.
 *
 * `undefined` allows it; a string denies it and becomes both the effect's
 * `detail` and the message the script sees. A promise is accepted, because
 * approval can mean waiting for a person — but only on bindings that are
 * already asynchronous. A synchronous call cannot wait, and the two cases are
 * kept visibly apart instead of being silently converted.
 */
export type Authorizer = (
  request: AuthorizationRequest,
) => string | undefined | Promise<string | undefined>;

export interface EvaluateOptions {
  /** Where the source claims to live. Shows up in stack traces and effect rows. */
  identifier?: string;
  /** Wall clock for the synchronous part. A module parked on `await` is not covered. */
  timeoutMs?: number;
}

export interface Evaluation {
  value: unknown;
  durationMs: number;
  effects: Effect[];
}

/**
 * `specifier` as written in an import, plus the module that wrote it.
 *
 * Returning `undefined` means "nobody mounted this", which is reported as a
 * link error naming the specifier rather than as a crash in the loader.
 */
export type Linker = (
  specifier: string,
  from: string,
) => vm.Module | undefined | Promise<vm.Module | undefined>;

export interface RealmOptions {
  /**
   * Builds this realm's linker. It is a function of the realm because mounting a
   * module means asking the realm to wrap host functions and to build modules
   * inside its own context — a plain `Linker` cannot do that from outside.
   */
  mounts?: (realm: Realm) => Linker;
  name?: string;
  /** Where `console` output goes. Defaults to the host's stderr. */
  onConsole?: (level: string, line: string) => void;
  /** Called as each effect completes, so a caller can stream rather than wait. */
  onEffect?: (effect: Effect) => void;
  /** Consulted before a binding reaches the host. Absent means everything runs. */
  authorize?: Authorizer;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `at name (file:line:col)` or `at file:line:col`.
 *
 * Both V8 and JSC print frames this way; the difference that matters is that
 * JSC gives up the identifier we set on the module and prints `unknown`, which
 * is why the file name comes from {@link Realm.#identifier} instead of the frame.
 */
const FRAME = /^\s*at\s+([^\s()]+\s+\()?([^\s:]+):(\d+):(\d+)\)?$/;

/**
 * JSC (Bun) names module frames `[source:N]` instead of the module's
 * identifier — a global counter, not a file. The line and column in that
 * frame are the real module positions, so accept it and report the module
 * being evaluated; without this the frame is rejected and the walk lands on
 * a host frame (which is how effects used to come back with realm.ts's own
 * line numbers under Bun).
 */
const SOURCE_FRAME = /^\s*at\s+(?:\[[^\]]+\]|unknown):(\d+):(\d+)$/;

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function summarize(value: unknown): string {
  const text = formatArg(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function basename(file: string): string {
  const path = file.startsWith("file://") ? file.slice("file://".length) : file;
  return path.split("/").pop() ?? path;
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function isPromise(value: unknown): value is Promise<string | undefined> {
  return typeof (value as { then?: unknown } | undefined)?.then === "function";
}

/**
 * A module graph that evaluates against its own globals.
 *
 * The source is evaluated as it was written: no wrapper, no preamble, so line
 * numbers in a stack trace are line numbers in the file. That is the whole
 * reason this is `SourceTextModule` and not `evaluate` of a function body.
 */
export class Realm {
  readonly #context: vm.Context;
  readonly #name: string;
  #linker: Linker | undefined;
  #effects: Effect[] = [];
  #modules = new Map<string, vm.Module>();
  #onEffect: ((effect: Effect) => void) | undefined;
  #authorize: Authorizer | undefined;
  #killed = false;
  /** The module being evaluated. Effects are attributed to it. */
  #identifier = "env.js";

  constructor(options: RealmOptions = {}) {
    this.#name = options.name ?? "realm";
    this.#onEffect = options.onEffect;
    this.#authorize = options.authorize;
    // eslint-disable-next-line react/naming-convention-context-name -- not a React context
    this.#context = vm.createContext({});
    this.#installConsole(options.onConsole);
    this.#linker = options.mounts?.(this);
  }

  get context(): vm.Context {
    return this.#context;
  }

  /** Effects recorded since the last {@link takeEffects}. */
  get effects(): readonly Effect[] {
    return this.#effects;
  }

  takeEffects(): Effect[] {
    const taken = this.#effects;
    this.#effects = [];
    return taken;
  }

  get killed(): boolean {
    return this.#killed;
  }

  /**
   * Abandons the realm.
   *
   * This is the answer to a script that parked on a promise and will never
   * come back. There is nothing to interrupt, so nothing is interrupted: the
   * realm is dropped, later calls throw, and the next run starts from `env.js`.
   * That is affordable here only because the state was never in this heap.
   */
  kill(): void {
    this.#killed = true;
    this.#modules.clear();
    this.#effects = [];
  }

  /**
   * Asks the authorizer on behalf of something that is not a binding call.
   *
   * Installing a package because a script imported it is a real effect, and it
   * happens in the loader, before any binding exists. Same question, same
   * answer shape, so the policy has one place to live.
   */
  authorize(
    name: string,
    input: readonly unknown[],
    at: Effect["at"],
  ): string | undefined | Promise<string | undefined> {
    return this.#authorize?.({ name, input, at });
  }

  /** Records an effect that did not go through a binding. */
  note(
    name: string,
    detail: string,
    at: Effect["at"],
    status: Effect["status"] = "ok",
    ms = 0,
  ): void {
    const effect: Effect = { name, at, status, ms: round(ms), detail };
    this.#effects.push(effect);
    this.#onEffect?.(effect);
  }

  /**
   * A host function, wrapped so it belongs to this realm.
   *
   * Wrapping is not cosmetic. A host function carries the host's `Function` as
   * its `constructor`, and `console.log.constructor("return process")()` is
   * then a way out of the realm. The wrapper is created inside the context, so
   * what a script sees has the realm's own prototypes and the host function
   * exists only in the closure.
   */
  wrap<Args extends unknown[], R>(
    fn: (...args: Args) => R,
  ): (...args: Args) => R {
    const factory = vm.runInContext(
      "(fn) => (...args) => fn(...args)",
      this.#context,
    ) as (fn: (...args: Args) => R) => (...args: Args) => R;
    return factory(fn);
  }

  /**
   * A host function that also records what it was asked to do.
   *
   * This is the ledger seam: a script reaches the host only through these, so
   * the effect list is the complete account of what one evaluation touched.
   *
   * `describe` decides what the row says. The default is the arguments, because
   * an effect is a record of what was asked for, not of what came back — a
   * returned file's contents do not belong in a log line.
   */
  binding<Args extends unknown[], R>(
    name: string,
    fn: (...args: Args) => R,
    describe?: (...args: Args) => string,
  ): (...args: Args) => R {
    const label =
      describe ?? ((...args: Args) => args.map(summarize).join(", "));
    return this.wrap((...args: Args): R => {
      const started = performance.now();
      const at = this.#callsite();
      const request = label(...args);
      const finish = (status: Effect["status"], detail: string): void => {
        const effect: Effect = {
          name,
          at,
          status,
          ms: round(performance.now() - started),
          detail,
        };
        this.#effects.push(effect);
        this.#onEffect?.(effect);
      };
      const deny = (reason: string): never => {
        finish("blocked", reason);
        throw new Error(`${name} was refused: ${reason}`);
      };
      const run = (): R => {
        if (this.#killed) deny("the realm was killed");
        try {
          const result = fn(...args);
          const thenable = result as { then?: unknown } | undefined;
          if (typeof thenable?.then === "function") {
            return (result as Promise<unknown>).then(
              (value) => {
                finish("ok", request);
                return value;
              },
              (error: unknown) => {
                finish("failed", request);
                throw error;
              },
            ) as R;
          }
          finish("ok", request);
          return result;
        } catch (error) {
          finish("failed", request);
          throw error;
        }
      };

      const verdict = this.#authorize?.({ name, input: args, at });
      if (verdict === undefined) return run();
      if (!isPromise(verdict)) return deny(verdict) as R;
      return (async () => {
        const reason = await verdict;
        if (reason !== undefined) deny(reason);
        return run();
      })() as R;
    }) as (...args: Args) => R;
  }

  /**
   * A host object rebuilt for the realm, its functions wrapped. The object is
   * still the host's, so this is for shape, not for isolation.
   */
  object<T extends Record<string, unknown>>(source: T): T {
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      wrapped[key] =
        typeof value === "function"
          ? this.wrap(value as (...args: unknown[]) => unknown)
          : value;
    }
    return wrapped as T;
  }

  /**
   * Sets a global in the realm. The value must already belong to the realm —
   * pass it through {@link wrap}, {@link binding} or {@link object} first.
   */
  global(name: string, value: unknown): void {
    (this.#context as Record<string, unknown>)[name] = value;
  }

  /** A module whose exports are host values, visible under `specifier`. */
  synthetic(specifier: string, exports: Record<string, unknown>): vm.Module {
    const names = Object.keys(exports);
    return new vm.SyntheticModule(
      names,
      function (this: vm.SyntheticModule) {
        for (const name of names) this.setExport(name, exports[name]);
      },
      { context: this.#context, identifier: specifier },
    );
  }

  async evaluate(
    source: string,
    options: EvaluateOptions = {},
  ): Promise<Evaluation> {
    if (this.#killed) throw new Error(`realm "${this.#name}" was killed`);
    const identifier = options.identifier ?? "esm.js";
    const started = Date.now();
    const effectStart = this.#effects.length;
    const previousIdentifier = this.#identifier;
    this.#identifier = identifier;
    const resolve = this.#resolver();

    try {
      const module = new vm.SourceTextModule(source, {
        context: this.#context,
        identifier,
        importModuleDynamically: async (specifier: string) => {
          const target = await resolve(specifier, identifier);
          if (target.status === "unlinked") {
            await target.link((inner: string, referencing: vm.Module) =>
              resolve(inner, referencing.identifier),
            );
          }
          if (target.status === "linked") await target.evaluate();
          return target;
        },
      });

      await module.link((specifier: string, referencing: vm.Module) =>
        resolve(specifier, referencing.identifier),
      );
      await module.evaluate({
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      const namespace = module.namespace as Record<string, unknown>;
      return {
        value: Object.hasOwn(namespace, "default")
          ? namespace.default
          : undefined,
        durationMs: Date.now() - started,
        effects: this.#effects.slice(effectStart),
      };
    } finally {
      this.#identifier = previousIdentifier;
    }
  }

  /**
   * One module instance per (from, specifier) pair for the life of the realm,
   * which is what makes a second import see the same module the first one got.
   * The cache lives here rather than per-evaluation for the same reason.
   */
  #resolver(): (specifier: string, from: string) => Promise<vm.Module> {
    return async (specifier, from) => {
      const key = `${from}\u0000${specifier}`;
      const cached = this.#modules.get(key);
      if (cached !== undefined) return cached;
      const linker = this.#linker;
      if (linker === undefined) {
        throw new Error(
          `cannot import "${specifier}" from ${from}: this realm mounts nothing`,
        );
      }
      const resolved = await linker(specifier, from);
      if (resolved === undefined) {
        throw new Error(
          `cannot import "${specifier}" from ${from}: not mounted`,
        );
      }
      this.#modules.set(key, resolved);
      return resolved;
    };
  }

  /**
   * The first frame that belongs to the realm rather than to the host.
   *
   * Every binding call goes host → wrapper → script, so the wrapper frame is a
   * reliable landmark on both V8 and JSC: skip everything up to it, then take
   * the first frame after it. Host frames (this package) are all before it.
   *
   * JSC prints `unknown` where V8 prints the module's identifier, so on Bun the
   * name falls back to the module being evaluated. The line is right either way;
   * the file is only right for the module at the top.
   */
  #callsite(): Effect["at"] {
    const stack = (new Error("callsite").stack ?? "").split("\n").slice(1);
    let afterWrapper = false;
    for (const raw of stack) {
      if (raw.includes("evalmachine")) {
        afterWrapper = true;
        continue;
      }
      if (!afterWrapper) continue;
      const source = SOURCE_FRAME.exec(raw);
      if (source !== null) {
        return {
          identifier: this.#identifier,
          line: Number(source[1]),
          column: Number(source[2]),
        };
      }
      const match = FRAME.exec(raw);
      if (match === null) continue;
      const file = match[2] ?? "";
      if (file.startsWith("node:") || file.startsWith("internal/")) continue;
      return {
        identifier:
          file === "unknown" || file.length === 0
            ? this.#identifier
            : basename(file),
        line: Number(match[3]),
        column: Number(match[4]),
      };
    }
    return { identifier: this.#identifier, line: 0, column: 0 };
  }

  /**
   * `console` is rebuilt inside the context on purpose. Handing the host's
   * console in would hand over a host function, and `console.log.constructor`
   * is then a way back out of the realm: the object literal must be evaluated
   * in the realm, not here.
   */
  #installConsole(
    onConsole: ((level: string, line: string) => void) | undefined,
  ): void {
    const sink = this.wrap((level: string, args: unknown[]) => {
      const line = args.map(formatArg).join(" ");
      if (onConsole !== undefined) {
        onConsole(level, line);
        return;
      }
      process.stderr.write(`[${this.#name}:${level}] ${line}\n`);
    });
    const build = vm.runInContext(
      "(sink) => ({ log: (...a) => sink('log', a), info: (...a) => sink('info', a), warn: (...a) => sink('warn', a), error: (...a) => sink('error', a) })",
      this.#context,
    ) as (sink: unknown) => unknown;
    (this.#context as Record<string, unknown>).console = build(sink);
  }
}
