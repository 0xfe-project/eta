/**
 * The model's key/value surface — `update_state` / `check_state` / `list_state`
 * (port of eta-agent's `tools/state.ts`, with its storage side made explicit).
 *
 * It is the session's own scratch space, not the configuration: whatever the
 * model wants to remember between turns goes into a namespace of its own and is
 * committed through the journal like everything else. That is what makes it
 * survive a restart — the point of a state tool is that the state is still there
 * tomorrow.
 *
 * Reads come from the storage (committed truth), writes go through the
 * journaling service, which orders them behind whatever the loop already queued.
 */
import { type SessionLog } from "@eta/core/session";
import {
  deleteValue,
  type StorageService,
  setValue,
  value,
} from "@eta/core/storage";
import type { JournalingService } from "./journaling";

/** The namespace the model's own keys live in. */
export const MODEL_STATE = "eta.model-state";

export interface StateKV {
  get(key: string): Promise<string | undefined>;
  /** `null` deletes the key. */
  set(key: string, next: string | null): Promise<void>;
  keys(): Promise<string[]>;
}

/** The session's own KV, journaled like everything else. */
export function sessionStateKV(
  log: SessionLog,
  journaling: JournalingService,
): StateKV {
  const storage: StorageService = log.storage;
  return {
    async get(key: string): Promise<string | undefined> {
      return (await storage.getValue(value<string>(MODEL_STATE, key)))?.value;
    },
    async set(key: string, next: string | null): Promise<void> {
      await journaling.writeValues([
        next === null
          ? deleteValue(value<string>(MODEL_STATE, key))
          : setValue(value<string>(MODEL_STATE, key), next),
      ]);
    },
    async keys(): Promise<string[]> {
      const stored = await storage.listValues(value<string>(MODEL_STATE));
      return stored.map((entry) => entry.address.key).sort();
    },
  };
}
