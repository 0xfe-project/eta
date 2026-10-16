/**
 * What a plugin sees (REFACTOR.md §9, P0.3).
 *
 * Structural on purpose, the way eta-old's plugin SDK was: a plugin is typed against this
 * interface and does not depend on cordis. At runtime the context *is* a cordis context — its
 * `routes` service and its `effect` — which is what makes "official plugins and the user's take
 * one loading path" true rather than aspirational.
 */
import type { RouteHandler } from "./routes";

export interface RoutesApi {
  /** Register a handler. The returned function takes the route back out again. */
  register: (
    method: string,
    pattern: string,
    handler: RouteHandler,
  ) => () => void;
  /** What is registered, for a host that wants to say so (and for tests). */
  routes: () => { method: string; pattern: string }[];
}

type PluginDisposer = () => void | Promise<void>;

export interface PluginContext {
  routes: RoutesApi;
  /**
   * Register this plugin's cleanup. It runs when the plugin comes out of the tree — on unload,
   * on reload, or at shutdown — which is what makes "uninstall leaves nothing behind" true for
   * a plugin that uses it, instead of a promise.
   */
  effect: (execute: () => PluginDisposer | Iterable<PluginDisposer>) => unknown;
  warn?: ((message: string) => void) | undefined;
}
