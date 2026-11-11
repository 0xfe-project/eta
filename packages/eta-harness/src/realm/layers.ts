import type { CapabilityMeta } from "./env-file";
import { join } from "node:path";
import { EnvFile } from "./env-file";

export type Layer = "self" | "project" | "global";

export interface LayerRoots {
  /** Personal layer, ~/.eta/sessions/{id}/ */
  self: string;
  /** Project layer, {project}/.eta/ (optional) */
  project?: string;
  /** Global layer, ~/.eta/global/ (optional) */
  global?: string;
}

/**
 * Managing the three env.js layers: self (personal) > project > global.
 *
 * Resolution only goes outward, never inward: the project layer can't see personal packages, the personal layer can use project packages.
 * Same-name capabilities override by priority: self > project > global.
 */
export class EnvLayers {
  readonly #layers: Map<Layer, EnvFile>;

  constructor(roots: LayerRoots) {
    this.#layers = new Map();
    this.#layers.set("self", new EnvFile(join(roots.self, "env.js")));
    if (roots.project) {
      this.#layers.set("project", new EnvFile(join(roots.project, "env.js")));
    }
    if (roots.global) {
      this.#layers.set("global", new EnvFile(join(roots.global, "env.js")));
    }
  }

  /**
   * Look up a capability by priority (self → project → global).
   * Return the first layer found and the capability source.
   */
  find(
    name: string,
  ): { layer: Layer; source: string; meta: CapabilityMeta } | undefined {
    for (const layer of ["self", "project", "global"] as const) {
      const file = this.#layers.get(layer);
      if (!file) continue;
      const cap = file.capability(name);
      if (cap) {
        return { layer, source: cap.source, meta: cap.meta };
      }
    }
    return undefined;
  }

  /**
   * Get a layer's EnvFile (may not exist).
   */
  get(layer: Layer): EnvFile | undefined {
    return this.#layers.get(layer);
  }

  /**
   * Determine which layer's env.js a file path belongs to.
   * Used for import-direction checks: the project layer must not import the personal layer.
   */
  layerOf(path: string): Layer | undefined {
    for (const [layer, file] of this.#layers) {
      if (file.path === path) return layer;
    }
    return undefined;
  }

  /**
   * Determine which layer a capability belongs to.
   * Used by authorize: project and global layer capabilities require approval, personal layer does not.
   */
  layerOfCapability(name: string): Layer | undefined {
    const found = this.find(name);
    return found?.layer;
  }

  /**
   * Reload files from all layers (capture external modifications).
   */
  reload(): void {
    for (const file of this.#layers.values()) {
      file.reload();
    }
  }

  /**
   * Compute the combined hash of all layers (used to decide whether to re-wake the realm).
   */
  get hash(): string {
    const hashes: string[] = [];
    for (const layer of ["self", "project", "global"] as const) {
      const file = this.#layers.get(layer);
      if (file) hashes.push(file.hash);
    }
    return hashes.join(":");
  }
}
