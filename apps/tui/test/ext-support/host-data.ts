/**
 * What a test host finds on disk when it starts: the providers in its `config.json` and persona
 * cards in its home, written into a data directory before the host is started on it.
 */
import type { Host } from "@eta/app/src/host";
import type { AgentView } from "@eta/client-contracts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../support/temp";
import { withHostWire } from "./host-wire";

export interface ConfiguredProvider {
  id: string;
  models: string[];
  /** `openai-compatible` (usable without a key) unless given. */
  kind?: string;
}

/**
 * A data directory whose `config.json` holds these providers, without keys: an OpenAI-compatible
 * one is usable at once, a kind that needs a key is listed but not usable.
 */
export async function dataDirWith(options: {
  providers?: ConfiguredProvider[];
  defaultModel?: string;
  /** Persona card files in the host's home, by id, holding a line of text each. */
  cards?: string[];
}): Promise<string> {
  const dataDir = await tempDir("eta-tui-setup-host-");
  const config = {
    providers: (options.providers ?? []).map((provider) => ({
      id: provider.id,
      kind: provider.kind ?? "openai-compatible",
      baseUrl: "http://127.0.0.1:9/v1",
      models: provider.models.map((id) => ({ id })),
    })),
    ...(options.defaultModel === undefined
      ? {}
      : { defaultModel: options.defaultModel }),
  };
  await writeFile(join(dataDir, "config.json"), JSON.stringify(config));
  if (options.cards !== undefined) {
    // `testHost` makes the data directory the agent's home too.
    const cards = join(dataDir, ".eta", "persona");
    await mkdir(cards, { recursive: true });
    for (const id of options.cards)
      await writeFile(join(cards, `${id}.persona.md`), `# ${id}\n`);
  }
  return dataDir;
}

/** The host's agents, as a client that connects now is told in its hello. */
export async function hostAgents(host: Host): Promise<AgentView[]> {
  return withHostWire(host, async (wire) =>
    (
      (wire.store.getState().targets.agents?.sections.list ?? []) as AgentView[]
    ).filter((agent) => agent.systemRole !== "captain"),
  );
}
