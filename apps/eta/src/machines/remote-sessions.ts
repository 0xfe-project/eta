/**
 * The router the upstream session host hands foreign session ids to.
 *
 * A session on a daemon is not in the primary's session manager, but the browser addresses it like
 * any other (`sessions.prompt`, `sessions.abort`, `sessions.answer`...). The upstream plugin asks
 * this router whether it owns an id, and if it does, gives it the call. The answer is the daemon's
 * own: the call is made on the daemon's pipe and its result comes back unchanged.
 *
 * "Owns" is a fact about the conversations: a session belongs to the machine of the project of the
 * conversation whose participant holds it, so the answer survives a restart with nothing kept.
 */
import type { SidebarSession } from "@eta/client-contracts";
import type { KernelModels } from "@eta/core";
import type { RemoteSessions } from "@eta/server";
import type { ConversationStore } from "../conversations/store";
import type { MachineHub, MachineLink } from "./hub";
import type { MachineRecord, MachineStore } from "./store";
import { modelSpecOf } from "@eta/daemon";
import { parseModelId } from "@eta/server";

/** Actions that wait on a model or on a whole compaction take as long as that takes. */
const LONG_ACTIONS = new Set(["compact", "goal", "fork"]);
const LONG_MS = 10 * 60 * 1000;
const SHORT_MS = 60 * 1000;

interface ForwardArgs {
  session?: string;
  model?: string;
  [key: string]: unknown;
}

export class RemoteSessionsRouter implements RemoteSessions {
  readonly #conversations: ConversationStore;
  readonly #machines: MachineStore;
  readonly #hub: MachineHub;
  readonly #models: () => KernelModels | undefined;

  constructor(options: {
    conversations: ConversationStore;
    machines: MachineStore;
    hub: MachineHub;
    models: () => KernelModels | undefined;
    /** The daemons' sessions, for the global list. */
    rows: () => SidebarSession[];
  }) {
    this.rows = options.rows;
    this.#conversations = options.conversations;
    this.#machines = options.machines;
    this.#hub = options.hub;
    this.#models = options.models;
  }

  /** The daemon machine a session runs on, if it is a remote one. */
  machineOf(sessionId: string): MachineRecord | undefined {
    const held = this.#conversations.ofSession(sessionId);
    if (held === undefined) return undefined;
    const machine = this.#machines.get(held.machineId);
    return machine?.kind === "daemon" ? machine : undefined;
  }

  readonly rows: () => SidebarSession[];

  owns = (id: string): boolean => this.machineOf(id) !== undefined;

  call: RemoteSessions["call"] = async (action, call) => ({
    result: await this.forward(action, (call.args ?? {}) as ForwardArgs),
  });

  /** One `sessions.*` action on the daemon that holds the session; what the browser's call does. */
  async forward(action: string, args: ForwardArgs): Promise<unknown> {
    const machine = this.machineOf(args.session ?? "");
    if (machine === undefined)
      throw new Error(`no such session: ${args.session}`);
    const link = this.#hub.link(machine.id);
    if (link === undefined) {
      throw new Error(
        `${machine.name} is ${machine.status}: its sessions cannot be reached until it is back`,
      );
    }
    // A model the user picks in the session's own controls has to be known to the daemon first.
    if (action === "modelSet" && typeof args.model === "string")
      await this.#teach(link, args.model);
    return await link.pipe.call("sessions", action, args, {
      timeoutMs: LONG_ACTIONS.has(action) ? LONG_MS : SHORT_MS,
    });
  }

  async #teach(link: MachineLink, model: string): Promise<void> {
    const identity = parseModelId(model);
    const known = this.#models()?.getModel(identity.provider, identity.modelId);
    if (known === undefined) throw new Error(`model_unavailable: ${model}`);
    await link.machine("catalog", {
      models: [
        modelSpecOf(known, {
          provider: identity.provider,
          id: identity.modelId,
        }),
      ],
    });
  }
}
