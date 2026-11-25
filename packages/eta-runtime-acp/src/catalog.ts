/**
 * Which ACP agents this machine has, and what each can be set to.
 *
 * The list is the config file's. For each agent, looking costs a process: start the command, say
 * `initialize`, open a session in an empty directory to read its config options (its models and
 * reasoning levels), and let it go. So an answer is kept five minutes, and dropped when the
 * agent's configuration changes. A session that opens for real tells what it saw too.
 */
import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpTestResult,
  AgentRuntimeInfo,
  AgentRuntimeModel,
} from "@eta/client-contracts";
import type { AcpConfigFile } from "./config";
import type { AcpChoices } from "./models";
import { accessSync, constants, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { env } from "node:process";
import { acpRuntimeId } from "./config";
import { isAuthError } from "./delegate";
import { choicesOf, modelsOf } from "./models";
import { AcpProcess, AcpStartError, messageOf, methods } from "./process";

/** What an agent's view says before anything answered: its command is there, nothing more. */
export const NOT_CHECKED = "Checking…";
const SIGN_IN = "Sign in from a terminal on this machine first.";

interface Probe {
  status: AcpAgentView["status"];
  version?: string;
  detail?: string;
  agentName?: string;
  authMethods?: string[];
  models: AgentRuntimeModel[];
}

interface Entry {
  /** The configuration the answer is about: another one is another question. */
  key: string;
  probe: Probe;
  at: number;
}

export interface AcpCatalogOptions {
  config: AcpConfigFile;
  /** How long an answer is good for. Default five minutes. */
  ttlMs?: number;
  /** How long an agent may take to answer each step. Default twenty seconds. */
  timeoutMs?: number;
  warn?: (message: string) => void;
}

function timed<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not answer in time`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

export class AcpCatalog {
  readonly #config: AcpConfigFile;
  readonly #ttlMs: number;
  readonly #timeoutMs: number;
  readonly #warn: (message: string) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #inflight = new Map<string, Promise<Entry>>();

  constructor(options: AcpCatalogOptions) {
    this.#config = options.config;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#warn = options.warn ?? (() => undefined);
  }

  /** The models last seen for an agent; none before anything was seen. */
  models(id: string): readonly AgentRuntimeModel[] {
    return this.#entries.get(id)?.probe.models ?? [];
  }

  /** A session of this agent opened and said what it can be set to. */
  learn(id: string, choices: AcpChoices): void {
    const entry = this.#entries.get(id);
    const models = modelsOf(choices);
    if (entry === undefined) {
      let agent: AcpAgentConfig | undefined;
      try {
        agent = this.#config.get(id);
      } catch {
        return;
      }
      if (agent === undefined) return;
      this.#entries.set(id, {
        key: JSON.stringify(agent),
        probe: { status: "available", models },
        // Old already: the next listing asks properly, for the version and the rest.
        at: 0,
      });
      return;
    }
    entry.probe = { ...entry.probe, status: "available", models };
    delete entry.probe.detail;
  }

  /** Forget what was seen: of one agent, or of all. */
  invalidate(id?: string): void {
    if (id === undefined) this.#entries.clear();
    else this.#entries.delete(id);
  }

  /** Whether some configured agent has no answer, or an old one. */
  stale(): boolean {
    return this.#config.read().some((agent) => {
      const entry = this.#entries.get(agent.id);
      return (
        entry === undefined ||
        entry.key !== JSON.stringify(agent) ||
        Date.now() - entry.at >= this.#ttlMs
      );
    });
  }

  /**
   * Every configured agent as it is known now, without asking. One nobody has looked at yet says
   * only whether its command is there, and that it has not been checked yet.
   */
  snapshot(): AcpAgentView[] {
    return this.#config.read().map((agent) => {
      const entry = this.#entries.get(agent.id);
      if (entry !== undefined && entry.key === JSON.stringify(agent))
        return viewOf(agent, entry.probe);
      return viewOf(
        agent,
        commandExists(agent)
          ? { status: "available", detail: NOT_CHECKED, models: [] }
          : { status: "missing", detail: "is not installed", models: [] },
      );
    });
  }

  /**
   * Every configured agent as a runtime, asked again where the answer is old. A file that cannot
   * be read lists none here, so the built-in runtimes still list; the settings page shows why.
   */
  async list(fresh = false): Promise<AgentRuntimeInfo[]> {
    let views: Awaited<ReturnType<AcpCatalog["views"]>>;
    try {
      views = await this.views(fresh);
    } catch (error) {
      this.#warn(
        `[eta-runtime-acp] ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
    return views.map(({ view, models }) => ({
      id: view.runtime,
      label: view.label,
      status: view.status,
      ...(view.version === undefined ? {} : { version: view.version }),
      ...(view.detail === undefined ? {} : { detail: view.detail }),
      models: [...models],
    }));
  }

  /** Every configured agent with what this machine found, for the settings screen. */
  async views(
    fresh = false,
  ): Promise<{ view: AcpAgentView; models: readonly AgentRuntimeModel[] }[]> {
    const agents = this.#config.read();
    for (const id of this.#entries.keys())
      if (!agents.some((agent) => agent.id === id)) this.#entries.delete(id);
    return await Promise.all(
      agents.map(async (agent) => {
        const { probe } = await this.#entry(agent, fresh);
        return { view: viewOf(agent, probe), models: probe.models };
      }),
    );
  }

  /** One agent's view, asked now. */
  async view(agent: AcpAgentConfig): Promise<AcpAgentView> {
    return viewOf(agent, (await this.#entry(agent, true)).probe);
  }

  /** Whether a configuration works at all: start it, `initialize`, let it go. Nothing is kept. */
  async test(agent: AcpAgentConfig): Promise<AcpTestResult> {
    const probe = await this.#probe(agent, false);
    return {
      ok: probe.status === "available",
      status: probe.status,
      ...(probe.agentName === undefined ? {} : { agentName: probe.agentName }),
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(probe.detail === undefined ? {} : { detail: probe.detail }),
      ...(probe.authMethods === undefined
        ? {}
        : { authMethods: probe.authMethods }),
    };
  }

  async #entry(agent: AcpAgentConfig, fresh: boolean): Promise<Entry> {
    const key = JSON.stringify(agent);
    const known = this.#entries.get(agent.id);
    if (
      !fresh &&
      known !== undefined &&
      known.key === key &&
      Date.now() - known.at < this.#ttlMs
    )
      return known;
    const running = this.#inflight.get(key);
    if (running !== undefined) return await running;
    const asking = this.#probe(agent, true)
      .then((probe) => ({ key, probe, at: Date.now() }))
      .finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, asking);
    const entry = await asking;
    this.#entries.set(agent.id, entry);
    return entry;
  }

  async #probe(agent: AcpAgentConfig, withSession: boolean): Promise<Probe> {
    const scratch = mkdtempSync(join(tmpdir(), "eta-acp-probe-"));
    let process: AcpProcess | undefined;
    try {
      process = await AcpProcess.start(
        {
          command: agent.command,
          args: agent.args,
          env: agent.env,
          cwd: scratch,
        },
        {
          update: () => undefined,
          // Nothing is prompted here, so nothing should ask; if it does, the answer is no.
          permission: async () => ({ outcome: { outcome: "cancelled" } }),
        },
        { timeoutMs: this.#timeoutMs, label: `acp.${agent.id}` },
      );
      const { init } = process;
      const authMethods = (init.authMethods ?? []).map((method) => method.name);
      const base = {
        ...(init.agentInfo == null
          ? {}
          : {
              agentName: init.agentInfo.title ?? init.agentInfo.name,
              version: init.agentInfo.version,
            }),
        ...(authMethods.length === 0 ? {} : { authMethods }),
      };
      if (!withSession) return { status: "available", ...base, models: [] };
      try {
        const session = await timed(
          process.agent.request(methods.agent.session.new, {
            cwd: scratch,
            mcpServers: [],
          }),
          this.#timeoutMs,
          agent.command,
        );
        if (init.agentCapabilities?.sessionCapabilities?.close != null)
          await timed(
            process.agent.request(methods.agent.session.close, {
              sessionId: session.sessionId,
            }),
            2_000,
            agent.command,
          ).catch(() => undefined);
        return {
          status: "available",
          ...base,
          models: modelsOf(choicesOf(session.configOptions)),
        };
      } catch (error) {
        if (isAuthError(error)) {
          const how = (init.authMethods ?? [])
            .map((method) => method.description ?? method.name)
            .join("; ");
          return {
            status: "unauthenticated",
            ...base,
            detail: `is not signed in${how === "" ? "" : ` (${how})`}. ${SIGN_IN}`,
            models: [],
          };
        }
        return {
          status: "error",
          ...base,
          detail: `could not open a session: ${messageOf(error)}`,
          models: [],
        };
      }
    } catch (error) {
      return {
        status:
          error instanceof AcpStartError && error.kind === "missing"
            ? "missing"
            : "error",
        detail: messageOf(error),
        models: [],
      };
    } finally {
      await process?.stop().catch(() => undefined);
      // The directory is only a place to stand: failing to remove it must not change the answer.
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch (error) {
        this.#warn(
          `[eta-runtime-acp] ${agent.id}: could not remove ${scratch}: ${messageOf(error)}`,
        );
      }
    }
  }
}

/** Whether an agent's command can be found: a path that exists, or a name on its PATH. */
function commandExists(agent: AcpAgentConfig): boolean {
  const executable = (path: string): boolean => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  };
  if (agent.command.includes("/") || agent.command.includes("\\"))
    return executable(resolve(agent.command));
  const path = agent.env.PATH ?? env.PATH ?? "";
  return path
    .split(delimiter)
    .some((dir) => dir !== "" && executable(join(dir, agent.command)));
}

function viewOf(agent: AcpAgentConfig, probe: Probe): AcpAgentView {
  return {
    ...agent,
    runtime: acpRuntimeId(agent.id),
    status: probe.status,
    ...(probe.version === undefined ? {} : { version: probe.version }),
    ...(probe.detail === undefined ? {} : { detail: probe.detail }),
  };
}
