/**
 * The ACP agents of every machine, as the settings page edits them: one machine at a time.
 *
 * Each machine keeps its own `~/.eta/acp.json`, and the same id on two machines is two agents.
 * The primary's file is edited here, through `AcpAdmin` (`@eta/runtime-acp`); a daemon's is
 * edited by the same code on the daemon, over its link (`acpList`, `acpSave`, `acpDelete`,
 * `acpTest`). A daemon that is not online is an error: nothing falls back to the primary.
 *
 * What only the primary knows stays here: which agents still run on `acp.<id>` on that machine
 * (an agent pinned to it, or one that follows its projects there), so an id in use is neither
 * renamed nor deleted. The rest (the checks, refusing to write a file that cannot be read whole,
 * not waiting for the look after a save) is `AcpAdmin`'s, on whichever machine has the file.
 */
import type {
  AcpAgentView,
  AcpMachineList,
  AcpTestResult,
  MachineKind,
  MachineStatus,
} from "@eta/client-contracts";
import type { AcpRuntimes } from "@eta/runtime-acp";
import type { ConversationStore } from "../conversations/store";
import type { MachineLink } from "../machines/hub";
import type { ProjectStore } from "../projects/store";
import { AcpAdmin, acpRuntimeId, checkAcpAgent } from "@eta/runtime-acp";

interface MachineFacts {
  id: string;
  kind: MachineKind;
  name: string;
  status: MachineStatus;
}

export interface AcpServiceOptions {
  /** The primary's own ACP agents; absent when this host runs none. */
  local: Pick<AcpRuntimes, "catalog" | "config"> | undefined;
  machines: {
    get: (id: string) => MachineFacts | undefined;
    primary: () => MachineFacts | undefined;
  };
  /** The machine's link while it is up. */
  link: (machineId: string) => Pick<MachineLink, "daemon"> | undefined;
  /** Every agent: its runtime, and the machine it is pinned to. */
  agents: () => readonly {
    id: string;
    name: string;
    runtime: string;
    machineId: string | null;
  }[];
  /** The lists moved: whoever watches them is told. */
  changed: () => void;
}

/** Where one call goes: this process, or a daemon's link. */
type Place =
  | { kind: "local"; machine: MachineFacts; admin: AcpAdmin }
  | {
      kind: "daemon";
      machine: MachineFacts;
      link: Pick<MachineLink, "daemon">;
    };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** How long a daemon may take to save (it does not wait for the look) and to test. */
const SAVE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

export class AcpService {
  readonly #options: AcpServiceOptions;
  readonly #admin: AcpAdmin | undefined;
  /** What each daemon last said, by machine id; only the ones asked for. */
  readonly #remote = new Map<string, AcpMachineList>();
  /**
   * Each daemon's fetch generation: an invariant, not a fix for an order seen today (one link
   * answers in completion order, and the daemon's settled list reads the file after its looks).
   * It keeps holding if that changes: a retry, a second channel, a list built from the looks.
   * A fetch writes what it hears only while its generation is still the latest: a newer fetch
   * (every save and delete starts one once it lands) or the machine going offline makes every
   * answer still on its way stale, so a slow look can never put back a list from before a save.
   */
  readonly #generations = new Map<string, number>();

  constructor(options: AcpServiceOptions) {
    this.#options = options;
    this.#admin =
      options.local === undefined
        ? undefined
        : new AcpAdmin({ acp: options.local, changed: options.changed });
  }

  /**
   * Every machine's list that is known, by machine id: the primary's always, a daemon's once it
   * was asked for and while it is online. A file that cannot be read whole is that machine's
   * `error`, never an empty list.
   */
  lists(): Record<string, AcpMachineList> {
    const out: Record<string, AcpMachineList> = {};
    const primary = this.#options.machines.primary();
    if (primary !== undefined && this.#admin !== undefined) {
      try {
        out[primary.id] = { agents: this.#admin.list() };
      } catch (error) {
        out[primary.id] = { error: messageOf(error) };
      }
    }
    for (const [machineId, list] of this.#remote) {
      if (this.#options.link(machineId) === undefined) {
        // Gone offline: what it said is no longer what it has, nor what is still on its way.
        this.#remote.delete(machineId);
        this.#nextGeneration(machineId);
        continue;
      }
      out[machineId] = list;
    }
    return out;
  }

  /**
   * Ask the machine for its list again: what it knows now at once, and what its looks find once
   * they are done. The primary's is always current; a daemon is asked over its link.
   */
  async refresh(machineId: string | undefined): Promise<AcpMachineList> {
    const place = this.#place(machineId);
    if (place.kind === "local") {
      this.#options.changed();
      try {
        return { agents: place.admin.list() };
      } catch (error) {
        return { error: messageOf(error) };
      }
    }
    return await this.#fetch(place);
  }

  /**
   * Add an agent on one machine, change one, or rename one. No `previousId` adds; `previousId`
   * equal to the agent's id changes it in place; another `previousId` renames that agent.
   */
  async save(
    machineId: string | undefined,
    raw: unknown,
    previousId?: string,
  ): Promise<AcpAgentView> {
    const place = this.#place(machineId);
    const agent = checkAcpAgent(raw);
    if (previousId !== undefined && previousId !== agent.id)
      this.#unused(place.machine, previousId, `rename ${previousId}`);
    if (place.kind === "local") return place.admin.save(agent, previousId);
    const view = await place.link.daemon(
      "acpSave",
      { agent, ...(previousId === undefined ? {} : { previousId }) },
      { timeoutMs: SAVE_TIMEOUT_MS },
    );
    void this.#fetch(place);
    return view;
  }

  async delete(machineId: string | undefined, id: string): Promise<void> {
    const place = this.#place(machineId);
    this.#unused(place.machine, id, `delete ${id}`);
    if (place.kind === "local") {
      place.admin.delete(id);
      return;
    }
    await place.link.daemon("acpDelete", { id });
    void this.#fetch(place);
  }

  /** Whether a configuration works on that machine, saved or not. */
  async test(
    machineId: string | undefined,
    raw: unknown,
  ): Promise<AcpTestResult> {
    const place = this.#place(machineId);
    const agent = checkAcpAgent(raw);
    if (place.kind === "local") return await place.admin.test(agent);
    return await place.link.daemon(
      "acpTest",
      { agent },
      { timeoutMs: TEST_TIMEOUT_MS },
    );
  }

  /** The machine a call is for: the primary when none is named. Never another one instead. */
  #place(machineId: string | undefined): Place {
    const { machines } = this.#options;
    const machine =
      machineId === undefined ? machines.primary() : machines.get(machineId);
    if (machine === undefined)
      throw new Error(
        machineId === undefined
          ? "this host has no primary machine yet"
          : `no such machine: ${machineId}`,
      );
    if (machine.kind === "primary") {
      if (this.#admin === undefined)
        throw new Error(`${machine.name} runs no ACP agents`);
      return { kind: "local", machine, admin: this.#admin };
    }
    if (machine.kind !== "daemon")
      throw new Error(`${machine.name} runs no ACP agents`);
    const link =
      machine.status === "online" ? this.#options.link(machine.id) : undefined;
    if (link === undefined)
      throw new Error(
        `${machine.name} is offline: its ACP agents cannot be read or changed until it is back`,
      );
    return { kind: "daemon", machine, link };
  }

  async #fetch(
    place: Extract<Place, { kind: "daemon" }>,
  ): Promise<AcpMachineList> {
    const id = place.machine.id;
    const generation = this.#nextGeneration(id);
    const ask = async (settled: boolean): Promise<AcpMachineList> => {
      let list: AcpMachineList;
      try {
        const { agents } = await place.link.daemon(
          "acpList",
          settled ? { settled } : {},
          { timeoutMs: settled ? TEST_TIMEOUT_MS : SAVE_TIMEOUT_MS },
        );
        list = { agents };
      } catch (error) {
        list = { error: messageOf(error) };
      }
      // Only the latest fetch, on the same link, may write: a later fetch or a link
      // that dropped meanwhile makes this answer old. Both of this fetch's answers carry its
      // generation, so its own `ask(true)` still writes while it is the latest: the looks always
      // reach the page, through this fetch or the newer one that asks again.
      if (
        this.#generations.get(id) === generation &&
        this.#options.link(id) === place.link
      ) {
        this.#remote.set(id, list);
        this.#options.changed();
      }
      return list;
    };
    const now = await ask(false);
    // The looks it started run behind; their answers arrive as the next list. Each fetch asks
    // for its own settled list, so the latest fetch always brings the looks in: a newer fetch
    // that drops this one's answer asks again itself. (Something that refreshes on a timer
    // faster than a look takes would starve them: let the settled answer land first.)
    if (now.agents !== undefined) void ask(true);
    return now;
  }

  #nextGeneration(machineId: string): number {
    const next = (this.#generations.get(machineId) ?? 0) + 1;
    this.#generations.set(machineId, next);
    return next;
  }

  /** Refuse when an agent still runs on `acp.<id>` on this machine. */
  #unused(machine: MachineFacts, id: string, what: string): void {
    const runtime = acpRuntimeId(id);
    const users = this.#options
      .agents()
      .filter(
        (agent) => agent.runtime === runtime && agent.machineId === machine.id,
      )
      .map((agent) => agent.name);
    if (users.length === 0) return;
    throw new Error(
      `Cannot ${what}: ${users.join(", ")} ${users.length === 1 ? "runs" : "run"} on ${runtime} on ${machine.name}. Move ${users.length === 1 ? "it" : "them"} to another runtime first.`,
    );
  }
}

/**
 * The machines of the projects an agent is in: its own home (`ownerAgentId`) and the ones of the
 * conversations it takes part in. An agent pinned to no machine runs its
 * runtime on each of them.
 */
export function projectMachinesOf(
  stores: {
    projects: Pick<ProjectStore, "list" | "get">;
    conversations: Pick<ConversationStore, "list" | "participants">;
  },
  agentId: string,
): Set<string> {
  const found = new Set<string>();
  for (const project of stores.projects.list())
    if (project.ownerAgentId === agentId) found.add(project.machineId);
  for (const conversation of stores.conversations.list()) {
    if (
      !stores.conversations
        .participants(conversation.id)
        .some((participant) => participant.agentId === agentId)
    )
      continue;
    const project = stores.projects.get(conversation.projectId);
    if (project !== undefined) found.add(project.machineId);
  }
  return found;
}
