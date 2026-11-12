/**
 * What the primary does for a daemon.
 *
 * The daemon holds no provider keys, no database and no product plugins, so over its link it asks
 * the primary for the things it lacks:
 *
 * - **Generation** (`model.stream`). The primary resolves the model, adds the credentials, streams
 *   from the provider and sends each event back. Keys and Codex tokens never leave this process,
 *   and usage is counted here.
 * - **Product tools** (`tool.call`). The real tool runs on the primary for that session. (It used
 *   to get an SSH environment over the link to read the machine's files; that went to TOBEREFR.)
 * - **The approval list** (`tool.gate`): does the user want to be asked before this tool runs?
 * - **Questions** (`ask.observe`): a session on the daemon asked, was answered or gave up; the
 *   conversation and the inbox hear it exactly as they hear a local session's.
 *
 * Every call names a session, and a session is only believed to be what the primary's own rows say
 * it is: the machine on the link must be the machine of the session's project, or of the task run
 * the session works for.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KernelModels, KernelTool } from "@eta/core";
import type { SessionMeta } from "@eta/server";
import type { ConversationStore } from "../conversations/store";
import type { ProjectStore } from "../projects/store";
import type { SessionHooks } from "../session-hooks";
import type { MachineLink } from "./hub";
import type { MachineStore } from "./store";
import { forwardedOptions } from "@eta/daemon";

export interface LinkServiceDeps {
  conversations: ConversationStore;
  /**
   * The task run a session works in now (a task's session outlives the run that made it), as the
   * primary's rows know it: whose agent and machine it is, what directory it works in, and what the
   * session is held in (`tasks/session-key.ts`, which the daemon files its prompt and tools under).
   */
  taskRun: (
    session: string,
  ) =>
    | { key: string; agentId: string; machineId: string; cwd: string }
    | undefined;
  projects: ProjectStore;
  machines: MachineStore;
  /** The model layer; not there until the server is up. */
  models: () => KernelModels | undefined;
  /** The product's per-session hooks; not there until the product is made. */
  hooks: () => Required<SessionHooks> | undefined;
  /** The tools the user wants to be asked about. */
  approvals: () => readonly string[];
  /** A generation ended: count it. */
  generated: (meta: SessionMeta, message: AssistantMessage) => void;
  warn: (message: string) => void;
}

/** A session of the link's machine, as the primary's rows know it. */
interface Held {
  meta: SessionMeta;
  cwd: string;
}

export function serveLink(link: MachineLink, deps: LinkServiceDeps): void {
  const tools = new Map<string, KernelTool[]>();

  /** The primary's own idea of a session, or nothing for one that is not this machine's. */
  const held = (session: unknown): Held | undefined => {
    if (typeof session !== "string") return undefined;
    const run = deps.taskRun(session);
    if (run !== undefined) {
      if (run.machineId !== link.machineId) return undefined;
      return {
        cwd: run.cwd,
        meta: {
          id: session,
          createdAt: 0,
          cwd: run.cwd,
          agentId: run.agentId,
          conversationId: run.key,
        },
      };
    }
    const found = deps.conversations.ofSession(session);
    if (found === undefined || found.machineId !== link.machineId)
      return undefined;
    const conversation = deps.conversations.get(found.conversationId);
    const project =
      conversation === undefined
        ? undefined
        : deps.projects.get(conversation.projectId);
    if (project === undefined) return undefined;
    return {
      cwd: project.path,
      meta: {
        id: session,
        createdAt: 0,
        cwd: project.path,
        agentId: found.agentId,
        conversationId: found.conversationId,
      },
    };
  };

  link.peer.handle("model.stream", async (raw, { signal, emit }) => {
    const params = raw as {
      session: string;
      model: { provider: string; id: string };
      context: never;
      options?: Record<string, unknown>;
    };
    const models = deps.models();
    const model = models?.getModel(params.model.provider, params.model.id);
    if (models === undefined || model === undefined) {
      throw new Error(
        `model_unavailable: ${params.model.provider}:${params.model.id}`,
      );
    }
    const stream = models.streamSimple(model, params.context, {
      ...forwardedOptions(params.options),
      signal,
    });
    for await (const event of stream) emit(event);
    const message = await stream.result().catch(() => undefined);
    if (message !== undefined) {
      // A session the primary does not know (a subagent's) is counted without an agent.
      const meta = held(params.session)?.meta ?? {
        id: params.session,
        createdAt: 0,
        cwd: "",
      };
      deps.generated(meta, message);
    }
    return undefined;
  });

  link.peer.handle("tool.gate", (raw) => {
    const { name } = raw as { name: string };
    return { ask: deps.approvals().includes(name) };
  });

  // GitHub is gone, but a daemon from before asks for its login every minute until it is
  // upgraded; "not connected" keeps it quiet where "unknown method" would warn each time.
  link.peer.handle("github.credentials", () => null);

  link.peer.handle("tool.call", async (raw, { signal }) => {
    const params = raw as {
      session: string;
      name: string;
      toolCallId: string;
      args: unknown;
    };
    const found = held(params.session);
    const hooks = deps.hooks();
    if (found === undefined || hooks === undefined)
      throw new Error(`unknown session: ${params.session}`);
    // A session's tools are made once; runs of one agent are sessions of their own.
    let set = tools.get(params.session);
    if (set === undefined) {
      set = hooks.sessionTools({
        meta: found.meta,
        session: undefined as never,
      });
      tools.set(params.session, set);
    }
    const tool = set.find((candidate) => candidate.name === params.name);
    if (tool === undefined) throw new Error(`no such tool: ${params.name}`);
    // TOBEREFR: this used to hand the tool an SshEnvironment over the link, so a primary's tool
    // read the remote machine's files. That environment went with @eta/execution.
    return await tool.execute(params.args, {
      turn: 0,
      toolCallId: params.toolCallId,
      signal,
      toolContext: {},
    });
  });

  link.peer.onNotify("ask.observe", (raw) => {
    const params = raw as {
      session: string;
      action: "asked" | "answered" | "canceled" | "expired";
      payload: never;
    };
    const found = held(params.session);
    if (found === undefined) return;
    deps.hooks()?.askObserve(found.meta)?.(params.action, params.payload);
  });
}
