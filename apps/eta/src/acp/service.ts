/**
 * The ACP agents this host runs, as the settings page edits them.
 *
 * The list is `~/.eta/acp.json` (`@eta/runtime-acp` reads it when a session opens, so there is no
 * second copy to keep in step). What this adds is the checking a hand-edit does not get, and the
 * one rule that needs the product: an agent that still answers on `acp.<id>` keeps that id.
 */
import type { AcpAgentView, AcpTestResult } from "@eta/client-contracts";
import type { AcpRuntimes } from "@eta/runtime-acp";
import { acpRuntimeId, checkAcpAgent } from "@eta/runtime-acp";

export interface AcpServiceOptions {
  acp: AcpRuntimes;
  /** Every agent, with the runtime it is on: who would be left without one. */
  agents: () => readonly { name: string; runtime: string }[];
  /** The list moved: whoever watches it is told. */
  changed: () => void;
}

export class AcpService {
  readonly #options: AcpServiceOptions;
  #refreshing = false;

  constructor(options: AcpServiceOptions) {
    this.#options = options;
  }

  /**
   * The agents as they are known now. What has not been looked at yet says whether its command
   * exists; the look itself runs behind, and tells when it has more to say.
   */
  list(): AcpAgentView[] {
    const { catalog } = this.#options.acp;
    if (catalog.stale() && !this.#refreshing) {
      this.#refreshing = true;
      void catalog
        .views()
        .catch(() => undefined)
        .finally(() => {
          this.#refreshing = false;
          this.#options.changed();
        });
    }
    return catalog.snapshot();
  }

  /**
   * Add an agent, change one, or rename one. No `previousId` adds; `previousId` equal to the
   * agent's id changes it in place; another `previousId` renames that agent.
   */
  async save(raw: unknown, previousId?: string): Promise<AcpAgentView> {
    const agent = checkAcpAgent(raw);
    const { config, catalog } = this.#options.acp;
    const agents = config.read();
    const taken = agents.some((item) => item.id === agent.id);
    if (previousId === undefined) {
      if (taken)
        throw new Error(
          `An ACP agent with the id ${agent.id} already exists. Choose another id.`,
        );
      agents.push(agent);
    } else {
      const at = agents.findIndex((item) => item.id === previousId);
      if (at < 0) throw new Error(`There is no ACP agent ${previousId}.`);
      if (previousId !== agent.id) {
        if (taken)
          throw new Error(
            `Cannot rename ${previousId} to ${agent.id}: an ACP agent with that id already exists.`,
          );
        this.#unused(previousId, `rename ${previousId}`);
      }
      agents[at] = agent;
      catalog.invalidate(previousId);
    }
    config.write(agents);
    catalog.invalidate(agent.id);
    const view = await catalog.view(agent);
    this.#options.changed();
    return view;
  }

  delete(id: string): void {
    const { config, catalog } = this.#options.acp;
    const agents = config.read();
    if (!agents.some((agent) => agent.id === id))
      throw new Error(`There is no ACP agent ${id}.`);
    this.#unused(id, `delete ${id}`);
    config.write(agents.filter((agent) => agent.id !== id));
    catalog.invalidate(id);
    this.#options.changed();
  }

  /** Whether a configuration works, saved or not: start it, shake hands, let it go. */
  async test(raw: unknown): Promise<AcpTestResult> {
    return await this.#options.acp.catalog.test(checkAcpAgent(raw));
  }

  #unused(id: string, what: string): void {
    const runtime = acpRuntimeId(id);
    const users = this.#options
      .agents()
      .filter((agent) => agent.runtime === runtime)
      .map((agent) => agent.name);
    if (users.length === 0) return;
    throw new Error(
      `Cannot ${what}: ${users.join(", ")} ${users.length === 1 ? "runs" : "run"} on ${runtime}. Move ${users.length === 1 ? "it" : "them"} to another runtime first.`,
    );
  }
}
