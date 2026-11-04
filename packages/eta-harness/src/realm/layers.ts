import type { CapabilityMeta } from "./env-file";
import { join } from "node:path";
import { EnvFile } from "./env-file";

export type Layer = "self" | "project" | "global";

export interface LayerRoots {
  /** 个人层，~/.eta/sessions/{id}/ */
  self: string;
  /** 项目层，{project}/.eta/ （可选）*/
  project?: string;
  /** 全局层，~/.eta/global/ （可选）*/
  global?: string;
}

/**
 * 三层 env.js 的管理：self（个人）> project（项目）> global（全局）。
 *
 * 解析只往外走，不往里走：项目层看不见个人包，个人层能用项目包。
 * 同名能力按优先级覆盖：self > project > global。
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
   * 按优先级（self → project → global）查找能力。
   * 返回第一个找到的层和能力源码。
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
   * 获取某一层的 EnvFile（可能不存在）。
   */
  get(layer: Layer): EnvFile | undefined {
    return this.#layers.get(layer);
  }

  /**
   * 判断某个文件路径属于哪一层的 env.js。
   * 用于执行解析方向检查：项目层不得 import 个人层。
   */
  layerOf(path: string): Layer | undefined {
    for (const [layer, file] of this.#layers) {
      if (file.path === path) return layer;
    }
    return undefined;
  }

  /**
   * 判断某个能力属于哪一层。
   * 用于 authorize：项目层和全局层的能力需要审批，个人层不需要。
   */
  layerOfCapability(name: string): Layer | undefined {
    const found = this.find(name);
    return found?.layer;
  }

  /**
   * 重新加载所有层的文件（捕获外部修改）。
   */
  reload(): void {
    for (const file of this.#layers.values()) {
      file.reload();
    }
  }

  /**
   * 计算所有层的联合 hash（用于判断是否需要重新唤醒 realm）。
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
