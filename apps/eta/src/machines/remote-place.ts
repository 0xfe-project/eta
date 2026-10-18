/**
 * The place for sessions that run on a daemon's machine.
 *
 * The engine asks a place for an agent's session and gets a handle. Here that is one call to the
 * daemon (`machine.open`), which brings the session in line with the agent exactly as the
 * primary does for its own: the agent's words, the model, the thinking level and the persona go
 * with the call, because they are the primary's, and so does the list of product tools the
 * session will have (the daemon registers proxies that call back here to run them).
 *
 * After that the handle is thin. A run is one long call (`machine.run`) that ends when the
 * session is quiet, a steer and a stop are ordinary `sessions.*` calls on the daemon's pipe, and a
 * link that dies under any of them fails them as an unknown outcome. Nothing is replayed.
 */
import type { RunOutcome, ToolSpec } from "@eta/client-contracts";
import type { KernelModels, KernelTool } from "@eta/core";
import type { Settings } from "@eta/server";
import type {
  EnsureInput,
  SessionHandle,
  SessionPlace,
  SessionSettings,
} from "../conversations/places";
import type { SessionHooks } from "../session-hooks";
import type { MachineHub, MachineLink } from "./hub";
import type { SessionMirrors } from "./mirror";
import type { MachineRecord } from "./store";
import { LINK_LIMITS } from "@eta/client-contracts";
import { modelSpecOf } from "@eta/daemon";
import { builtinPersonas } from "@eta/harness";
import { discoverPersonas, parseModelId } from "@eta/server";

export interface RemotePlaceDeps {
  hub: MachineHub;
  mirrors: SessionMirrors;
  /** The model layer and the session defaults; not there until the server is up. */
  models: () => KernelModels | undefined;
  defaults: () => Promise<Settings>;
  /** The product's per-session hooks; not there until the product is made. */
  hooks: () => Required<SessionHooks> | undefined;
  /** The primary's home: where the user's own persona cards are. */
  home: string;
  /** A `sessions.*` action on a session of a daemon, the way the browser's are sent. */
  forward: (
    action: string,
    args: { session: string; [key: string]: unknown },
  ) => Promise<unknown>;
  warn: (message: string) => void;
}

class RemoteHandle implements SessionHandle {
  readonly id: string;
  readonly #link: MachineLink;
  readonly #warn: (message: string) => void;
  #running = false;

  constructor(id: string, link: MachineLink, warn: (message: string) => void) {
    this.id = id;
    this.#link = link;
    this.#warn = warn;
  }

  get running(): boolean {
    return this.#running;
  }

  async steer(text: string): Promise<void> {
    await this.#link.pipe.call("sessions", "prompt", {
      session: this.id,
      text,
      mode: "steer",
    });
  }

  async run(prompt: string): Promise<RunOutcome> {
    this.#running = true;
    try {
      return await this.#link.daemon(
        "run",
        { session: this.id, text: prompt },
        { timeoutMs: LINK_LIMITS.runTimeoutMs },
      );
    } finally {
      this.#running = false;
    }
  }

  abort(): void {
    this.#link.pipe
      .call("sessions", "abort", { session: this.id })
      .catch((error: unknown) =>
        this.#warn(`[eta] could not stop ${this.id}: ${String(error)}`),
      );
  }
}

export class RemotePlace implements SessionPlace {
  readonly #deps: RemotePlaceDeps;

  constructor(deps: RemotePlaceDeps) {
    this.#deps = deps;
  }

  async ensure(input: EnsureInput): Promise<SessionHandle> {
    const { hub, mirrors } = this.#deps;
    const { machine, agent, conversation } = input;
    const link = hub.link(machine.id);
    if (link === undefined) {
      throw new Error(
        `${machine.name} is ${machine.status === "online" ? "starting" : machine.status}, so ${agent.name} cannot answer there now`,
      );
    }
    const defaults = await this.#deps.defaults();
    const model = agent.model ?? defaults.model;
    const thinkingLevel = agent.thinkingLevel ?? defaults.thinkingLevel;
    // With no model chosen a session runs on the kernel's placeholder, which only a model layer
    // that answers to anything (a test's) resolves; the daemon is told about it the same way.
    const identity =
      model === undefined
        ? { provider: "unknown", modelId: "unknown" }
        : parseModelId(model);
    const known = this.#deps
      .models()
      ?.getModel(identity.provider, identity.modelId);
    const { session } = await link.machine("open", {
      ...(input.existing === null ? {} : { session: input.existing }),
      cwd: input.cwd,
      title: `${conversation.name} · ${agent.name}`,
      agentId: agent.id,
      conversationId: conversation.id,
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      ...(agent.persona === "" ? {} : { persona: agent.persona }),
      systemPrompt: input.prompt,
      stamp: input.stamp,
      personaCards: await this.#cards(),
      ...(known === undefined
        ? {}
        : {
            modelSpec: modelSpecOf(known, {
              provider: identity.provider,
              id: identity.modelId,
            }),
          }),
      tools: this.#tools(conversation.id, agent.id, input.cwd),
    });
    if (session !== input.existing) input.created(session);
    mirrors.register(session, machine.id);
    return new RemoteHandle(session, link, this.#deps.warn);
  }

  async configure(
    sessionId: string,
    machine: MachineRecord,
    settings: SessionSettings,
  ): Promise<void> {
    if (this.#deps.hub.link(machine.id) === undefined)
      throw new Error(`${machine.name} is ${machine.status}`);
    if (settings.model !== undefined)
      await this.#deps.forward("modelSet", {
        session: sessionId,
        model: settings.model,
      });
    if (settings.thinkingLevel !== undefined)
      await this.#deps.forward("thinkingLevel", {
        session: sessionId,
        level: settings.thinkingLevel,
      });
  }

  /** What the product adds to this agent's sessions, as the daemon needs to know it. */
  #tools(conversationId: string, agentId: string, cwd: string): ToolSpec[] {
    const hooks = this.#deps.hooks();
    if (hooks === undefined) return [];
    const made = hooks.sessionTools({
      meta: { id: "", createdAt: 0, cwd, agentId, conversationId },
      session: undefined as never,
    });
    return made.map((tool: KernelTool) => ({
      name: tool.name,
      ...(tool.description === undefined
        ? {}
        : { description: tool.description }),
      parameters: (tool as { parameters?: unknown }).parameters ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  /** The persona cards the user keeps here; the built-in ones are on every machine already. */
  async #cards() {
    const { home, warn } = this.#deps;
    const builtin = builtinPersonas();
    const found = await discoverPersonas({ cwd: home, home, warn });
    return [...found.values()]
      .filter((card) => builtin[card.id] !== card.content)
      .map((card) => ({ id: card.id, name: card.name, content: card.content }));
  }
}
