/**
 * The ACP agents one machine runs, as a settings page edits them: the primary's own, and a
 * daemon's over its link. Both run this same code on their own `~/.eta/acp.json`.
 *
 * The list is the file (`createAcpRuntimes` reads it when a session opens, so there is no second
 * copy to keep in step). What this adds is the checking a hand-edit does not get. Which agents
 * still run on `acp.<id>` is not known here (agents are the primary's): the primary asks that
 * before it renames or deletes.
 *
 * A file that cannot be read whole refuses every change (`AcpConfigFile.read` throws), and the
 * list says why instead of being empty. `save` and `delete` run from read to write without
 * yielding, so two calls on this machine cannot interleave and lose one another's change. `save`
 * does not wait for the agent to be looked at: that runs behind, and `changed` says when it is in.
 */
import type { AcpAgentView, AcpTestResult } from "@eta/client-contracts";
import type { AcpRuntimes } from "./index";
import { checkAcpAgent } from "./config";

export interface AcpAdminOptions {
  acp: Pick<AcpRuntimes, "catalog" | "config">;
  /** The list moved (a change, or a look that finished): whoever watches it is told. */
  changed?: () => void;
}

export class AcpAdmin {
  readonly #acp: AcpAdminOptions["acp"];
  readonly #changed: () => void;
  #refreshing = false;

  constructor(options: AcpAdminOptions) {
    this.#acp = options.acp;
    this.#changed = options.changed ?? (() => undefined);
  }

  /** The file the agents are kept in. */
  get path(): string {
    return this.#acp.config.path;
  }

  /**
   * The agents as they are known now. What has not been looked at yet says whether its command
   * exists; the look itself runs behind, and `changed` tells when it has more to say. Throws when
   * the file cannot be read whole.
   */
  list(): AcpAgentView[] {
    const { catalog } = this.#acp;
    const snapshot = catalog.snapshot();
    if (catalog.stale() && !this.#refreshing) {
      this.#refreshing = true;
      void catalog
        .views()
        .catch(() => undefined)
        .finally(() => {
          this.#refreshing = false;
          this.#changed();
        });
    }
    return snapshot;
  }

  /** The agents once every look under way, or due, has finished: what `list` will say next. */
  async settled(): Promise<AcpAgentView[]> {
    const { catalog } = this.#acp;
    // A look already under way for the same configuration is waited for, not started again.
    await catalog.views().catch(() => undefined);
    return catalog.snapshot();
  }

  /**
   * Add an agent, change one, or rename one. No `previousId` adds; `previousId` equal to the
   * agent's id changes it in place; another `previousId` renames that agent.
   */
  save(raw: unknown, previousId?: string): AcpAgentView {
    const agent = checkAcpAgent(raw);
    const { config, catalog } = this.#acp;
    // Throws when the file is there but cannot be read whole: then nothing is written.
    const agents = config.read();
    const taken = agents.some((item) => item.id === agent.id);
    if (previousId === undefined) {
      if (taken)
        throw new Error(
          `An ACP agent with the id ${agent.id} already exists on this machine. Choose another id.`,
        );
      agents.push(agent);
    } else {
      const at = agents.findIndex((item) => item.id === previousId);
      if (at < 0) throw new Error(`There is no ACP agent ${previousId}.`);
      if (previousId !== agent.id && taken)
        throw new Error(
          `Cannot rename ${previousId} to ${agent.id}: an ACP agent with that id already exists on this machine.`,
        );
      agents[at] = agent;
      catalog.invalidate(previousId);
    }
    config.write(agents);
    catalog.invalidate(agent.id);
    this.#changed();
    // The look costs a process and may take its full timeouts: it runs behind, and what it
    // finds arrives as the next list. Until then the agent says it is being checked.
    void catalog
      .view(agent)
      .catch(() => undefined)
      .finally(() => this.#changed());
    const view = catalog.snapshot().find((item) => item.id === agent.id);
    if (view === undefined)
      throw new Error(`${agent.id} was saved but is not in ${config.path}.`);
    return view;
  }

  delete(id: string): void {
    const { config, catalog } = this.#acp;
    // Throws when the file is there but cannot be read whole: then nothing is written.
    const agents = config.read();
    if (!agents.some((agent) => agent.id === id))
      throw new Error(`There is no ACP agent ${id}.`);
    config.write(agents.filter((agent) => agent.id !== id));
    catalog.invalidate(id);
    this.#changed();
  }

  /** Whether a configuration works, saved or not: start it, shake hands, let it go. */
  async test(raw: unknown): Promise<AcpTestResult> {
    return await this.#acp.catalog.test(checkAcpAgent(raw));
  }
}
