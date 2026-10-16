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

const EMPTY_CONFIG: EtaConfig = {};

/** The providers the config lists, in the order it lists them. */
export function configuredProviders(config: EtaConfig): EtaProviderConfig[] {
  return config.providers ?? [];
}

/** How many tools may be on the approval list: a settings file, not a program. */
const MAX_APPROVAL_TOOLS = 64;

/**
 * The tool names that ask before running, as the config lists them.
 *
 * Sanitised on the read path like the headers are: one unusable entry is dropped rather than making
 * the whole file unreadable, names are trimmed and deduplicated, and a list that is not a list of
 * strings is no list at all.
 */
export function approvalTools(config: EtaConfig): string[] {
  const raw = config.approvals?.tools;
  if (!Array.isArray(raw)) return [];
  const tools: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name.length === 0 || tools.includes(name)) continue;
    tools.push(name);
    if (tools.length >= MAX_APPROVAL_TOOLS) break;
  }
  return tools;
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
