/**
 * The host's configuration: `~/.eta/config.json`, the file eta and its editor both write.
 *
 * A missing or unreadable file is a warning, not a failure: a host with no providers still
 * serves, and saying so on stderr is more useful than refusing to start.
 */
import { readFile } from "node:fs/promises";

/** One model service, as the config file lists it (`providers` is an array). */
export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey?: string | undefined;
  kind?: string | undefined;
  name?: string | undefined;
  headers?: Record<string, string> | undefined;
  models?: unknown[] | undefined;
}

export interface EtaConfig {
  providers: ProviderConfig[];
  defaultModel?: string | undefined;
}

export const EMPTY_CONFIG: EtaConfig = { providers: [] };

export async function readConfig(
  path: string,
  warn: (message: string) => void,
): Promise<EtaConfig> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as Partial<EtaConfig>;
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      ...(parsed.defaultModel === undefined
        ? {}
        : { defaultModel: parsed.defaultModel }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      warn(`[eta] no config at ${path}; starting with no providers`);
    } else {
      warn(`[eta] could not read ${path}: ${String(error)}`);
    }
    return EMPTY_CONFIG;
  }
}
