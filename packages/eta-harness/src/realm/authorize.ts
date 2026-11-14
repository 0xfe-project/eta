import type { Layer } from "./layers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ApprovalRecord {
  layer: Layer;
  capability: string;
  approved: boolean;
  timestamp: number;
}

export interface AuthorizeRequest {
  layer: Layer;
  capability: string;
  args: readonly unknown[];
}

export interface ApprovalStore {
  /** Check if a capability is approved */
  isApproved: (layer: Layer, capability: string) => boolean;
  /** Record an approval decision */
  record: (layer: Layer, capability: string, approved: boolean) => void;
  /** Get all records */
  all: () => ApprovalRecord[];
}

/**
 * File-based approval record store.
 *
 * Stores approvals in a JSON file at the specified path.
 * Each approval is keyed by (layer, capability).
 */
export class FileApprovalStore implements ApprovalStore {
  readonly #path: string;
  #records: Map<string, ApprovalRecord>;

  constructor(path: string) {
    this.#path = path;
    this.#records = new Map();
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#path)) {
      return;
    }
    try {
      const text = readFileSync(this.#path, "utf8");
      const data = JSON.parse(text) as ApprovalRecord[];
      this.#records.clear();
      for (const record of data) {
        const key = `${record.layer}:${record.capability}`;
        this.#records.set(key, record);
      }
    } catch {
      // Corrupted file, start fresh
      this.#records.clear();
    }
  }

  #save(): void {
    const records = Array.from(this.#records.values());
    const text = JSON.stringify(records, null, 2);
    const dir = dirname(this.#path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.#path, text, "utf8");
  }

  isApproved(layer: Layer, capability: string): boolean {
    const key = `${layer}:${capability}`;
    const record = this.#records.get(key);
    return record !== undefined && record.approved;
  }

  record(layer: Layer, capability: string, approved: boolean): void {
    const key = `${layer}:${capability}`;
    const record: ApprovalRecord = {
      layer,
      capability,
      approved,
      timestamp: Date.now(),
    };
    this.#records.set(key, record);
    this.#save();
  }

  all(): ApprovalRecord[] {
    return Array.from(this.#records.values());
  }
}

export type AskHuman = (request: AuthorizeRequest) => Promise<boolean>;

/**
 * Authorize a capability call from a shared layer.
 *
 * - Personal layer (self): always approved, no questions asked
 * - Project/Global layer: check approval store first, if not found ask human
 *
 * @param request The authorization request
 * @param store The approval store to check/update
 * @param askHuman Function to ask human for approval (can be undefined for testing)
 * @returns undefined if approved, error message if blocked
 */
export async function authorize(
  request: AuthorizeRequest,
  store: ApprovalStore,
  askHuman?: AskHuman,
): Promise<string | undefined> {
  const { layer, capability } = request;

  // Personal layer: always approved
  if (layer === "self") {
    return undefined;
  }

  // Check approval store first
  if (store.isApproved(layer, capability)) {
    return undefined;
  }

  // Need to ask human
  if (askHuman === undefined) {
    // No way to ask, deny by default
    return `Capability "${capability}" from ${layer} layer requires approval`;
  }

  const approved = await askHuman(request);
  store.record(layer, capability, approved);

  if (!approved) {
    return `User denied capability "${capability}" from ${layer} layer`;
  }

  return undefined;
}

/**
 * Create a default approval store path for a session.
 */
export function defaultApprovalStorePath(sessionRoot: string): string {
  return join(sessionRoot, "approvals.json");
}
