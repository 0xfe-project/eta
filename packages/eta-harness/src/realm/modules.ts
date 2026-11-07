import type { ApprovalStore, AuthorizeRequest } from "./authorize";
import type { CapabilityMeta } from "./env-file";
import type { AskRequest, AskResult, Hooks } from "./hooks";
import type { EnvLayers, Layer } from "./layers";
import type { MemoryApi, MemorySection } from "./memory";
import type { Linker, Realm } from "./realm";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import * as vm from "node:vm";
import { authorize } from "./authorize";
import { mountNodeModules } from "./host-modules";
import { linkMcpModule, MCP_PREFIX, mcpDiscovery } from "./mcp";
import { createMemoryModule, MEMORY_FILE } from "./memory";

/**
 * Manages concurrent eta.ask calls with a maximum concurrency limit.
 * Queues requests beyond the limit and processes them in FIFO order.
 * Flattens results in call order (not completion order).
 */
class ConcurrentQueue {
  private running = new Set<number>();
  private pending: Array<{
    seq: number;
    request: AskRequest;
    resolve: (result: AskResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private completedResults = new Map<number, AskResult>();
  private resolvers = new Map<
    number,
    { resolve: (result: AskResult) => void; reject: (error: unknown) => void }
  >();
  private nextSeq = 0;
  private nextFlushSeq = 0;
  private readonly maxConcurrent: number;
  private readonly ask: (request: AskRequest) => Promise<AskResult>;
  private paused = false;

  constructor(
    ask: (request: AskRequest) => Promise<AskResult>,
    maxConcurrent = 5,
  ) {
    this.ask = ask;
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Enqueue an eta.ask call. Returns a promise that resolves when:
   * 1. The call gets a turn slot and completes
   * 2. All earlier calls have also completed (to maintain call order)
   */
  async enqueue(request: AskRequest): Promise<AskResult> {
    const seq = this.nextSeq++;

    return new Promise<AskResult>((resolve, reject) => {
      if (this.paused) {
        // If paused, immediately reject
        reject(new Error("eta.ask queue is paused"));
        return;
      }

      // Store the resolver for this sequence number
      this.resolvers.set(seq, { resolve, reject });

      const item = { seq, request, resolve, reject };

      if (this.running.size < this.maxConcurrent) {
        // Start immediately
        void this.startTurn(item);
      } else {
        // Queue for later
        this.pending.push(item);
      }
    });
  }

  private async startTurn(item: {
    seq: number;
    request: AskRequest;
    resolve: (result: AskResult) => void;
    reject: (error: unknown) => void;
  }): Promise<void> {
    this.running.add(item.seq);

    try {
      const result = await this.ask(item.request);
      this.completedResults.set(item.seq, result);
      this.tryFlush();
    } catch (error) {
      // The error was already recorded as "failed" by realm.binding
      // We need to store it so we can maintain call order and reject the right promise
      const resolver = this.resolvers.get(item.seq);
      if (resolver) {
        this.resolvers.delete(item.seq);
        resolver.reject(error);
      }
      // Still need to advance nextFlushSeq
      if (item.seq === this.nextFlushSeq) {
        this.nextFlushSeq++;
        this.tryFlush();
      }
    } finally {
      this.running.delete(item.seq);
      this.tryStartNext();
    }
  }

  /**
   * Flush completed results in call order.
   * Only resolve promises when all earlier calls have completed.
   */
  private tryFlush(): void {
    while (this.completedResults.has(this.nextFlushSeq)) {
      const result = this.completedResults.get(this.nextFlushSeq)!;
      this.completedResults.delete(this.nextFlushSeq);

      // Resolve the promise for this sequence
      const resolver = this.resolvers.get(this.nextFlushSeq);
      if (resolver) {
        this.resolvers.delete(this.nextFlushSeq);
        resolver.resolve(result);
      }

      this.nextFlushSeq++;
    }
  }

  private tryStartNext(): void {
    if (this.pending.length === 0 || this.paused) return;
    if (this.running.size >= this.maxConcurrent) return;

    const next = this.pending.shift();
    if (next !== undefined) {
      void this.startTurn(next);
    }
  }

  /**
   * Pause the queue. All running turns will complete,
   * but no new turns will start.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Cancel all pending and running turns.
   * Flushes partial results for running turns.
   */
  cancelAll(): AskResult[] {
    this.paused = true;
    const results: AskResult[] = [];

    // Cancel all pending (not yet started)
    for (const item of this.pending) {
      const result: AskResult = {
        text: "Cancelled by user",
        effects: [],
        stack: item.request.parentStack ?? ["main"],
        status: "cancelled",
      };
      results.push(result);

      // Store in completedResults to maintain ordering
      this.completedResults.set(item.seq, result);
    }
    this.pending = [];

    // Try to flush whatever we can
    this.tryFlush();

    // Note: running turns will complete naturally and their results
    // will be marked as cancelled if the host supports it.

    return results;
  }

  /**
   * Resume the queue after pause.
   */
  resume(): void {
    this.paused = false;
    this.tryStartNext();
  }

  get stats() {
    return {
      running: this.running.size,
      pending: this.pending.length,
      completed: this.completedResults.size,
      paused: this.paused,
    };
  }
}

export interface ModuleMountOptions {
  /** Everything is resolved and named relative to this directory. */
  root: string;
  /** The three-layer capability structure (when using Agent) */
  layers?: EnvLayers;
  /** Hooks needed for eta module exports (memory, spawn) */
  hooks?: Hooks;
  /** Approval store for shared layer capability authorization */
  approvalStore?: ApprovalStore;
  /** Where relative `node:fs` paths resolve. Defaults to the host process cwd. */
  cwd?: string;
}

/**
 * The specifier rules, in the one place they exist.
 *
 * `node:` goes to the mounted Node surface. A path is read as a file. A bare
 * specifier is a package: it is looked for in `node_modules`, and if it is not
 * there it is installed into the project — visible in `node_modules`, in
 * `package.json` and in the lockfile, so the change can be read and diffed.
 *
 * The alternative, letting the resolver fetch into a global cache, makes the
 * install invisible and ties the whole runtime to one package manager. Being
 * explicit costs one `bun add` and buys a tree that means something.
 */
export function mountModules(
  realm: Realm,
  options: ModuleMountOptions,
): Linker {
  const node = mountNodeModules(realm, options.cwd);
  const files = new Map<string, vm.Module>();
  const { layers, hooks, approvalStore } = options;

  // Each layer gets its own modules registry
  const capabilityRegistries = new Map<Layer, Record<string, unknown>>([
    ["self", {}],
    ["project", {}],
    ["global", {}],
  ]);

  // One MEMORY.md per layer, next to that layer's env.js:
  // self → ~/.eta/sessions/{id}/, project → {project}/.eta/, global → ~/.eta/global/.
  const memoryModules = new Map<Layer, MemoryApi>();
  for (const layer of ["self", "project", "global"] as const) {
    const env = layers?.get(layer);
    if (env !== undefined)
      memoryModules.set(
        layer,
        createMemoryModule(join(dirname(env.path), MEMORY_FILE)),
      );
  }

  // Create concurrent queue for eta.ask (max 5 concurrent calls)
  let askQueue: ConcurrentQueue | undefined;
  if (hooks?.ask) {
    askQueue = new ConcurrentQueue(hooks.ask, 5);
  }

  /**
   * Wrap a capability function with authorization check.
   * For self layer, no check is performed.
   * For project/global layers, check approval before execution.
   */
  function wrapWithAuthorization(fn: any, name: string, layer: Layer): any {
    // Personal layer: no authorization needed
    if (layer === "self") {
      return fn;
    }

    // Shared layers (project/global): wrap with authorization check
    if (typeof fn !== "function") {
      return fn;
    }

    // Return a wrapper that checks authorization before calling the actual function
    // Use a regular function to preserve sync/async behavior
    return function (this: any, ...args: any[]) {
      // Check authorization
      if (approvalStore && hooks?.authorize) {
        const request: AuthorizeRequest = {
          layer,
          capability: name,
          args,
        };

        // Fast path: if already approved, call directly (preserve sync behavior)
        if (approvalStore.isApproved(layer, name)) {
          return fn.apply(this, args);
        }

        // Slow path: need to ask for approval (becomes async)
        const refusalPromise = authorize(
          request,
          approvalStore,
          async (req) => {
            // Use the provided authorize hook to ask the human
            const result = await hooks.authorize!({
              name: `capability.${req.layer}.${req.capability}`,
              input: req.args,
              at: { identifier: "eta.modules", line: 0, column: 0 },
            });
            // Convert hooks.authorize result to boolean:
            // undefined = approved (return true)
            // string = denied (return false)
            return result === undefined;
          },
        );

        // Return a promise chain that handles authorization then calls the function
        return refusalPromise.then((refusal) => {
          if (refusal !== undefined) {
            throw new Error(refusal);
          }
          // Authorization passed, call the actual function
          return fn.apply(this, args);
        });
      }

      // No authorization needed, call the actual function directly
      return fn.apply(this, args);
    };
  }

  async function link(
    specifier: string,
    from: string,
  ): Promise<vm.Module | undefined> {
    if (specifier.startsWith("node:")) {
      return node(specifier, from) as vm.Module | undefined;
    }

    // Handle mcp: specifiers (only when hooks.mcp is provided)
    if (specifier.startsWith(MCP_PREFIX)) {
      return await linkMcpModule(realm, hooks?.mcp, specifier);
    }

    // Handle eta: specifiers (only when layers are provided)
    if ((specifier.startsWith("eta:") || specifier === "eta") && layers) {
      return loadEtaModule(specifier, from);
    }

    const file = specifier.startsWith("file://")
      ? specifier.slice("file://".length)
      : await resolveSpecifier(
          specifier,
          from,
          { root: installRoot(from) },
          realm,
        );
    if (file === undefined) return undefined;
    return load(file);
  }

  /**
   * Where a bare import is installed: the layer the importing file lives under
   * (a project capability's packages belong to the project), else the agent root.
   */
  function installRoot(from: string): string {
    for (const layer of ["project", "global"] as const) {
      const env = layers?.get(layer);
      if (env === undefined) continue;
      const dir = dirname(env.path);
      if (from === env.path || from.startsWith(`${dir}/`)) return dir;
    }
    return options.root;
  }

  function loadEtaModule(specifier: string, fromPath: string): vm.Module {
    if (!layers) {
      throw new Error("eta: modules require layers to be provided");
    }
    let layer: Layer;
    let name: string | undefined;

    if (specifier === "eta") {
      // "eta" resolves to the current layer (the layer of the importing file)
      // If the importing file is not part of any layer (user code), default to self
      const fromLayer = layers.layerOf(fromPath);
      layer = fromLayer || "self";
    } else {
      // Parse "eta:layer:name", "eta:layer", or "eta:name"
      // Parse "eta:layer:name" or "eta:name"
      const parts = specifier.slice(4).split(":");
      if (parts.length === 2) {
        // "eta:project:format" - pinned to a layer
        layer = parts[0] as Layer;
        name = parts[1];
      } else {
        // parts.length === 1: "eta:project" names the layer's own module,
        // anything else is a capability resolved by priority.
        if (
          parts[0] === "self" ||
          parts[0] === "project" ||
          parts[0] === "global"
        ) {
          layer = parts[0] as Layer;
          name = undefined;
        } else {
          name = parts[0];
          const found = layers.find(name);
          if (found === undefined) {
            throw new Error(`Capability not found: ${name}`);
          }
          layer = found.layer;
        }
      }
    }

    // Enforce directionality: resolution only goes outward (self → project → global)
    // project cannot import from self; global cannot import from self or project
    const fromLayer = layers.layerOf(fromPath);
    if (fromLayer) {
      const canImport =
        fromLayer === "self" || // self can import from any layer
        (fromLayer === "project" && layer !== "self") || // project can import from project/global
        (fromLayer === "global" && layer === "global"); // global can only import from global
      if (!canImport) {
        throw new Error(
          `Layer ${fromLayer} cannot import from layer ${layer}: resolution only goes outward (self → project → global)`,
        );
      }
    }

    // Cache key is always the fully qualified "eta:layer:name"
    const cacheKey = name ? `eta:${layer}:${name}` : `eta:${layer}`;

    const cached = files.get(cacheKey);
    if (cached !== undefined) return cached;

    if (name) {
      // Handle built-in memory module
      if (name === "memory") {
        const memoryModule = memoryModules.get(layer);
        if (!memoryModule) {
          throw new Error(`Memory module not available for layer ${layer}`);
        }
        const module = createMemoryModuleWrapper(cacheKey, memoryModule);
        files.set(cacheKey, module);
        return module;
      }

      // This is a capability import like "eta:format" or "eta:global:format"
      // Return module that exports from registry (will be populated when env.js is evaluated)
      // If the capability doesn't exist, the runtime will throw when trying to access it
      const module = createCapabilityModule(cacheKey, layer, name);
      files.set(cacheKey, module);
      return module;
    } else {
      // This is the main eta module for a layer
      const module = createEtaModule(layer, cacheKey);
      files.set(cacheKey, module);
      return module;
    }
  }

  function createEtaModule(layer: Layer, identifier: string): vm.Module {
    const registry = capabilityRegistries.get(layer)!;
    const exports = ["default", "define", "modules", "mcp"];
    if (hooks?.memory) exports.push("memory");
    if (hooks?.spawn) exports.push("spawn");
    if (hooks?.ask) exports.push("ask");
    if (hooks?.platform) exports.push("platform");
    if (hooks?.state) exports.push("state");

    return new vm.SyntheticModule(
      exports,
      function () {
        // A binding, not a bare wrap: a define writes a layer's env.js, so it is an effect
        // and belongs in the ledger like any other host call.
        const defineFn = realm.binding(
          "eta.define",
          (name: string, source: unknown, meta?: unknown) => {
            // source can be a function (passed directly from env.js) or a string (to be compiled)
            let fn: any;
            let sourceCode: string;
            if (typeof source === "function") {
              fn = source;
              // Convert function back to source code for persistence
              sourceCode = source.toString();
            } else if (typeof source === "string") {
              fn = vm.runInContext(`(${source})`, realm.context);
              sourceCode = source;
            } else {
              throw new TypeError(
                `eta.define expects source to be function or string, got ${typeof source}`,
              );
            }

            // Wrap the function with authorization check for shared layers
            const wrappedFn = wrapWithAuthorization(fn, name, layer);

            // Register in memory
            registry[name] = wrappedFn;

            // Write through to the corresponding layer's env.js
            if (layers) {
              const envFile = layers.get(layer);
              if (envFile) {
                try {
                  envFile.add(name, sourceCode, (meta as CapabilityMeta) || {});
                } catch (err) {
                  // If capability already exists with different source, that's an error
                  // Remove from registry since write failed
                  delete registry[name];
                  throw err;
                }
              }
            }

            return name;
          },
          // The row names what was defined and where, not the whole source.
          (name: string) => `${layer}:${String(name)}`,
          // Defining is recorded, not gated: env.js defines on every wake, and the
          // shared-layer gate is on calling a capability (wrapWithAuthorization).
          { authorize: false },
        );

        const etaObject: Record<string, any> = {
          define: defineFn,
          modules: registry,
        };

        if (hooks?.memory) {
          const memory = hooks.memory;
          etaObject.memory = {
            append: realm.binding("eta.memory.append", (text: string) =>
              memory.append(text),
            ),
            read: realm.binding("eta.memory.read", (query: string) =>
              memory.read(query),
            ),
          };
        }

        if (hooks?.spawn) {
          const spawn = hooks.spawn;
          etaObject.spawn = realm.binding(
            "eta.spawn",
            (request: { prompt: string; model?: string }) => spawn(request),
          );
        }

        if (hooks?.ask && askQueue) {
          etaObject.ask = realm.binding(
            "eta.ask",
            (prompt: string, options?: { model?: string }) => {
              // Build the new stack entry: truncate prompt to 30 chars
              const truncated =
                prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt;
              const entry = `eta.ask("${truncated}")`;

              // Pass the parent stack in the request. The host merges this
              // with the session stack, so depth here counts from this call
              // down; if the host's own stack is deeper, its count wins.
              const parentStack = [entry];
              const depth = parentStack.length;

              // Enqueue the request through the concurrent queue
              const result = askQueue.enqueue({
                prompt,
                model: options?.model,
                parentStack,
                depth,
              });

              // Deep recursion is a warning, never a stop (ESMMODE-IMPL §三):
              // ≥10 layers is where a model is usually going in circles.
              // The runtime stamps depth; a host with a deeper session stack
              // stamps its own (larger) warning — whoever sees more wins.
              if (depth >= 10) {
                return result.then((value) => {
                  value.warning ??= `eta.ask recursion depth is ${depth}; consider returning a result instead of asking again`;
                  return value;
                });
              }

              return result;
            },
            (prompt, options) =>
              `${prompt.slice(0, 80)}${options?.model !== undefined ? ` [model:${options.model}]` : ""}`,
          );
        }

        if (hooks?.platform) {
          const services =
            typeof hooks.platform === "function"
              ? hooks.platform()
              : hooks.platform;
          const platform: Record<string, unknown> = {};
          for (const [name, call] of Object.entries(services)) {
            platform[name] = realm.binding(
              `eta.platform.${name}`,
              async (input?: unknown) => realm.own(await call(input ?? {})),
            );
          }
          etaObject.platform = platform;
        }

        // The host's object itself: `eta.state.x = y` is a plain assignment, and every
        // layer's `eta` sees the same one.
        if (hooks?.state) etaObject.state = hooks.state;

        // Always there: without a sink every call says MCP is not on this machine.
        etaObject.mcp = mcpDiscovery(realm, hooks?.mcp);

        // Export default as the eta object
        this.setExport("default", etaObject);
        // Also export named exports for backward compat
        this.setExport("modules", registry);
        this.setExport("define", defineFn);
        if (hooks?.memory) this.setExport("memory", etaObject.memory);
        if (hooks?.spawn) this.setExport("spawn", etaObject.spawn);
        if (hooks?.ask) this.setExport("ask", etaObject.ask);
        if (hooks?.platform) this.setExport("platform", etaObject.platform);
        if (hooks?.state) this.setExport("state", etaObject.state);
        this.setExport("mcp", etaObject.mcp);
      },
      { context: realm.context, identifier },
    );
  }

  function createCapabilityModule(
    identifier: string,
    layer: Layer,
    name: string,
  ): vm.Module {
    // A capability is a single default export from the registry
    return new vm.SyntheticModule(
      ["default"],
      function () {
        const registry = capabilityRegistries.get(layer)!;
        const fn = registry[name];
        if (fn === undefined) {
          throw new Error(
            `Capability ${name} not found in ${layer} layer registry`,
          );
        }
        this.setExport("default", fn);
      },
      { context: realm.context, identifier },
    );
  }

  /**
   * `eta:{layer}:memory`. Entries are copied into the realm (its own JSON), so
   * a script never holds a host object whose prototype leads back out.
   */
  function createMemoryModuleWrapper(
    identifier: string,
    memory: MemoryApi,
  ): vm.Module {
    const intoRealm = vm.runInContext(
      "(json) => json === undefined ? undefined : JSON.parse(json)",
      realm.context,
    ) as (json: string | undefined) => unknown;
    const own = (value: unknown): unknown =>
      intoRealm(value === undefined ? undefined : JSON.stringify(value));
    const api = {
      list: realm.wrap((section?: MemorySection) => own(memory.list(section))),
      get: realm.wrap((id: string) => own(memory.get(id))),
      add: realm.binding(
        "eta.memory.add",
        (section: MemorySection, text: string) => memory.add(section, text),
        (section, text) => `${section}: ${String(text).slice(0, 80)}`,
      ),
      remove: realm.binding("eta.memory.remove", (id: string) =>
        memory.remove(id),
      ),
    };
    // The default export is built inside the realm too, not a host `{}`.
    const bundle = vm.runInContext(
      "(list, get, add, remove) => ({ list, get, add, remove })",
      realm.context,
    ) as (...fns: unknown[]) => unknown;
    const exports = {
      ...api,
      default: bundle(api.list, api.get, api.add, api.remove),
    };
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports))
          this.setExport(name, value);
      },
      { context: realm.context, identifier },
    );
  }

  function load(path: string): vm.Module {
    const cached = files.get(path);
    if (cached !== undefined) return cached;

    const module = new vm.SourceTextModule(readFileSync(path, "utf8"), {
      context: realm.context,
      identifier: path,
      importModuleDynamically: async (specifier: string) => {
        const target = await link(specifier, path);
        if (target === undefined)
          throw new Error(`cannot import "${specifier}" from ${path}`);
        if (target.status === "unlinked")
          await target.link(asModuleLinker(link));
        if (target.status === "linked") await target.evaluate();
        return target;
      },
    });
    // Registered before linking so a cycle resolves to the same instance.
    files.set(path, module);
    return module;
  }

  return link;
}

/** `Linker` speaks in identifiers; `vm.ModuleLinker` hands over the module. */
function asModuleLinker(link: Linker): vm.ModuleLinker {
  return async (specifier, referencing) => {
    const resolved = await link(specifier, referencing.identifier);
    if (resolved === undefined) {
      throw new Error(
        `cannot import "${specifier}" from ${referencing.identifier}: not mounted`,
      );
    }
    return resolved;
  };
}

/** `specifier` from `from` as an absolute path on disk, or `undefined`. */
export async function resolveSpecifier(
  specifier: string,
  from: string,
  options: { root: string },
  realm: Realm,
): Promise<string | undefined> {
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    isAbsolute(specifier)
  ) {
    const base = isAbsolute(specifier)
      ? specifier
      : resolve(dirname(from), specifier);
    return withExtension(base);
  }

  const installed = installedPath(specifier, options.root);
  if (installed !== undefined) return installed;

  const at = { identifier: from, line: 0, column: 0 };
  const refusal = await realm.authorize("packages.install", [specifier], at);
  if (refusal !== undefined) {
    realm.note("packages.install", `${specifier}: ${refusal}`, at, "blocked");
    return undefined;
  }

  const started = performance.now();
  const added = spawnSync("bun", ["add", specifier], {
    cwd: options.root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const detail =
    added.status === 0
      ? `${specifier} into ${options.root}`
      : `bun add ${specifier} failed: ${(added.stderr || added.stdout || "no output").trim().split("\n").at(-1)}`;
  realm.note(
    "packages.install",
    detail,
    at,
    added.status === 0 ? "ok" : "failed",
    performance.now() - started,
  );

  const after = installedPath(specifier, options.root);
  if (after === undefined) return undefined;
  return after;
}

/**
 * The package as it sits in a `node_modules`, never out of a global cache.
 *
 * It does not go through `Bun.resolveSync`, which keeps answering with
 * `~/.bun/install/cache/...` even after the package has been installed into the
 * project. Accepting that answer would mean the project's tree never changes,
 * so resolution is done against `node_modules` directly.
 */
function installedPath(specifier: string, root: string): string | undefined {
  const { name, subpath } = splitSpecifier(specifier);
  const dir = packageDir(name, root);
  if (dir === undefined) return undefined;
  if (subpath.length > 0) return withExtension(join(dir, subpath));
  return entryOf(dir);
}

/** `@scope/name/sub/path` → `{ name: "@scope/name", subpath: "sub/path" }`. */
function splitSpecifier(specifier: string): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const depth = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, depth).join("/"),
    subpath: parts.slice(depth).join("/"),
  };
}

function packageDir(name: string, root: string): string | undefined {
  let dir = root;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** `exports`, then `module`, then `main`, then `index.js`. */
function entryOf(dir: string): string | undefined {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    manifest = {};
  }

  let entry: unknown = manifest.module ?? manifest.main;
  const exportsField = manifest.exports as
    | Record<string, unknown>
    | string
    | undefined;
  if (typeof exportsField === "string") {
    entry = exportsField;
  } else if (exportsField !== undefined && exportsField !== null) {
    const dot = (exportsField as Record<string, unknown>)["."] as unknown;
    if (typeof dot === "string") entry = dot;
    else if (dot !== undefined && dot !== null) {
      const conditions = dot as Record<string, unknown>;
      entry = conditions.import ?? conditions.module ?? conditions.default;
      if (typeof entry !== "string") entry = undefined;
    }
  }

  const base =
    typeof entry === "string" ? join(dir, entry) : join(dir, "index.js");
  return withExtension(base) ?? withExtension(join(dir, "index.js"));
}

const EXTENSIONS = [
  "",
  ".js",
  ".mjs",
  ".ts",
  "/index.js",
  "/index.mjs",
  "/index.ts",
];

function withExtension(base: string): string | undefined {
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}
