import type { EtaConfig, EtaProviderConfig } from "./providers/config-types";
/**
 * The configuration file: `~/.eta/config.json`, the one eta and its editor both write.
 *
 * The shape of it lives with the providers runtime (`providers/config-types.ts`); this file is
 * only the reading, and a missing or unreadable file is a warning rather than a failure — a host
 * with no providers still serves, and saying so on stderr beats refusing to start.
 */
import { readFile } from "node:fs/promises";

export type { EtaConfig, EtaProviderConfig };

export const EMPTY_CONFIG: EtaConfig = {};

/** The providers the config lists, in the order it lists them. */
export function configuredProviders(config: EtaConfig): EtaProviderConfig[] {
  return config.providers ?? [];
}

export async function readConfig(
  path: string,
  warn: (message: string) => void,
): Promise<EtaConfig> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as EtaConfig;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      warn(`[eta] no config at ${path}; starting with no providers`);
    } else {
      warn(`[eta] could not read ${path}: ${String(error)}`);
    }
    return EMPTY_CONFIG;
  }
}
