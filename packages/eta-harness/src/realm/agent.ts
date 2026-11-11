import type { ApprovalStore } from "./authorize";

import type { EnvFile } from "./env-file";
import type { CtxView, Hooks } from "./hooks";
import type { Evaluation } from "./realm";
import { defaultApprovalStorePath, FileApprovalStore } from "./authorize";
import { mountFileOps } from "./file-ops";
import { mountGlobals, mountNodeGlobals, mountShell } from "./host-modules";
import { EnvLayers } from "./layers";
import { mountModules } from "./modules";
import { Realm } from "./realm";

export interface AgentOptions {
  /** The agent's directory (personal layer). `env.js` lives at its root. */
  root: string;
  /** Project layer directory (optional). */
  project?: string;
  /** Global layer directory (optional). */
  global?: string;
  hooks?: Hooks;
  /** Approval store for shared layer capabilities (optional). Defaults to file-based store. */
  approvalStore?: ApprovalStore;
  /**
   * The working directory a script sees: relative paths in `node:fs`, `$`,
   * `search`/`view`/`edit` resolve here. Defaults to the host process cwd.
   */
  cwd?: string;
}

/**
 * One agent, one realm.
 *
 * Waking is evaluating `env.js`; there is no other start-up path and no heap to
 * restore. The file's hash decides whether a live realm is stale, so a change
 * to an ability takes effect on the next run without anyone having to remember
 * to restart something.
 *
 * The abilities themselves are not stored here. `eta.define` registers the
 * function the file already contains, which is why nothing needs dumping: the
 * source is the storage.
 */
export class Agent {
  readonly root: string;
  readonly layers: EnvLayers;
  /** Backwards compat: env.js pointing at the self layer */
  readonly env: EnvFile;
  readonly #hooks: Hooks;
  readonly #approvalStore: ApprovalStore;
  readonly #cwd: string | undefined;
  #realm: Realm | undefined;
  #waking: { hash: string; done: Promise<void> } | undefined;
  #woken = false;
  #hash = "";

  constructor(options: AgentOptions) {
    this.root = options.root;
    this.#hooks = options.hooks ?? {};
    this.#cwd = options.cwd;
    this.layers = new EnvLayers({
      self: options.root,
      project: options.project,
      global: options.global,
    });
    // Compat property: points at the self layer
    this.env = this.layers.get("self")!;
    // Initialize approval store
    this.#approvalStore =
      options.approvalStore ??
      new FileApprovalStore(defaultApprovalStorePath(options.root));
  }

  get capabilities() {
    return this.env.capabilities;
  }

  get awake(): boolean {
    return (
      this.#realm !== undefined &&
      this.#woken &&
      this.#hash === this.layers.hash
    );
  }

  /** The live realm, re-woken if the source changed underneath it. */
  realm(): Realm {
    this.layers.reload();
    const hash = this.layers.hash;
    if (this.#realm !== undefined && this.#hash === hash) return this.#realm;

    const realm = this.#create();
    this.#realm = realm;
    this.#hash = hash;
    this.#woken = false;
    return realm;
  }

  /** Wakes the realm: evaluates `env.js` once per realm. */
  async wake(): Promise<void> {
    const realm = this.realm();
    const hash = this.#hash;
    if (this.#woken) return;

    // Two runs can arrive before the first one has finished waking. Both must
    // wait for the same evaluation rather than the second one racing past it
    // into a realm whose abilities are half defined.
    if (this.#waking?.hash === hash) return this.#waking.done;

    // Wake all layers in order: global first, then project, then self (reverse priority)
    const toEval: Array<{ source: string; id: string }> = [];
    const globalFile = this.layers.get("global");
    if (globalFile) {
      toEval.push({
        source: globalFile.source,
        id: globalFile.path,
      });
    }
    const projectFile = this.layers.get("project");
    if (projectFile) {
      toEval.push({
        source: projectFile.source,
        id: projectFile.path,
      });
    }
    toEval.push({ source: this.env.source, id: this.env.path });

    const done = (async () => {
      for (const { source, id } of toEval) {
        await realm.evaluate(source, { identifier: id });
      }
    })()
      .then(() => {
        this.#woken = true;
      })
      .finally(() => {
        if (this.#waking?.done === done) this.#waking = undefined;
      });
    this.#waking = { hash, done };
    return done;
  }

  /** Evaluates `source` on top of the agent's abilities. */
  async run(
    source: string,
    options: { identifier?: string; timeoutMs?: number } = {},
  ): Promise<Evaluation> {
    await this.wake();
    return (this.#realm as Realm).evaluate(source, options);
  }

  /** Reloads capability layers to pick up changes in env files. */
  reload(): void {
    this.layers.reload();
    // Dispose and re-wake to rebuild the realm with updated layers
    this.dispose();
  }

  dispose(): void {
    this.#realm?.kill();
    this.#realm = undefined;
    this.#waking = undefined;
    this.#woken = false;
    this.#hash = "";
  }

  #create(): Realm {
    const hooks = this.#hooks;
    const realm = new Realm({
      name: "agent",
      mounts: (r) =>
        mountModules(r, {
          root: this.root,
          layers: this.layers,
          hooks: this.#hooks,
          approvalStore: this.#approvalStore,
          ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        }),
      onConsole: hooks.onConsole,
      onEffect: hooks.onEffect,
      authorize: hooks.authorize,
    });
    mountGlobals(realm);
    mountNodeGlobals(realm);
    mountShell(realm, this.#cwd);
    mountFileOps(realm, this.#cwd);
    mountNonEtaHooks(realm, hooks);
    return realm;
  }
}

/**
 * `ctx`, `emit`, `tools` — the surface a script may use besides `eta`.
 * (`eta`, and with it `eta.platform` and `eta.state`, is a module, not a global.)
 *
 * Only the slots the host filled are mounted. A half-wired host gets a realm
 * that works and simply does not have the parts it did not provide, which keeps
 * the runtime testable on its own.
 */
function mountNonEtaHooks(realm: Realm, hooks: Hooks): void {
  if (hooks.ctx !== undefined) {
    const view: CtxView = hooks.ctx();
    realm.global("ctx", {
      frame: view.frame,
      budget: view.budget,
      messages: realm.binding("ctx.messages", (count?: number) =>
        view.messages(count),
      ),
    });
  }

  if (hooks.emit !== undefined) {
    const emit = hooks.emit;
    realm.global("emit", {
      text: realm.binding("emit.text", (text: string) => emit.text?.(text)),
      progress: realm.binding("emit.progress", (text: string) =>
        emit.progress?.(text),
      ),
      image: realm.binding(
        "emit.image",
        (input: { mime: string; base64: string; alt?: string }) =>
          emit.image?.(input),
      ),
    });
  }

  if (hooks.tools !== undefined) {
    const tools = hooks.tools;
    realm.global("tools", {
      edit: realm.binding(
        "tools.edit",
        (request: { path: string; find: string; replace: string }) =>
          tools.edit?.(request),
      ),
      ask: realm.binding("tools.ask", (question: string) =>
        tools.ask?.(question),
      ),
    });
  }
}
