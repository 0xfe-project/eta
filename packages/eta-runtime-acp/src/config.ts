/**
 * `~/.eta/acp.json`: the ACP agents this machine runs, as the user configured them.
 *
 * The file is `{ "agents": AcpAgentConfig[] }`. It is read every time it is asked for (it is a
 * few lines, and the user may edit it by hand), and written whole. Because it is written whole, a
 * file that cannot be read whole is an error, never an empty or shorter list: one bad entry
 * fails the read, and nothing is written until the user fixes it.
 */
import type { AcpAgentConfig } from "@eta/client-contracts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { ACP_AGENT_ID } from "@eta/client-contracts";

const PREFIX = "acp.";

/** `acp.<id>` for an agent id. */
export function acpRuntimeId(id: string): `acp.${string}` {
  return `${PREFIX}${id}`;
}

/** The agent id in a runtime id; undefined when the id is not an ACP runtime's. */
export function acpAgentId(runtime: string): string | undefined {
  if (!runtime.startsWith(PREFIX)) return undefined;
  const id = runtime.slice(PREFIX.length);
  return ACP_AGENT_ID.test(id) ? id : undefined;
}

export function defaultAcpConfigPath(home: string = homedir()): string {
  return join(home, ".eta", "acp.json");
}

/**
 * An agent as the file should hold it, from whatever was handed in. Throws with words a person
 * can act on when it does not hold up.
 */
export function checkAcpAgent(raw: unknown): AcpAgentConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("an ACP agent is an object");
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!ACP_AGENT_ID.test(id))
    throw new Error(
      `the id ${JSON.stringify(value.id ?? "")} is not valid: use lowercase letters, digits and dashes, starting with a letter or digit`,
    );
  const command = typeof value.command === "string" ? value.command.trim() : "";
  if (command === "") throw new Error("the command is empty");
  const label =
    typeof value.label === "string" && value.label.trim() !== ""
      ? value.label.trim()
      : id;
  if (value.args !== undefined && !isStrings(value.args))
    throw new Error("args is a list of strings");
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    if (
      typeof value.env !== "object" ||
      value.env === null ||
      Array.isArray(value.env)
    )
      throw new Error("env is an object of strings");
    for (const [key, item] of Object.entries(value.env)) {
      if (key.trim() === "")
        throw new Error("an environment variable has an empty name");
      if (typeof item !== "string")
        throw new Error(`the environment variable ${key} is not a string`);
      env[key] = item;
    }
  }
  // Anything else is left behind, whatever it holds: `cwd` and `autoAllow` from older files (the
  // process starts in the session's directory, and every permission request is answered yes)
  // are read past, and the next write no longer has them.
  return {
    id,
    label,
    command,
    args: [...((value.args as string[] | undefined) ?? [])],
    env,
  };
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** `acp.json` is there but cannot be read whole. Nothing may be written over it until it is fixed. */
export class AcpConfigError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(
      `${path} ${reason}. Fix the file by hand; nothing is changed until it reads.`,
    );
    this.name = "AcpConfigError";
    this.path = path;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(raw: unknown): string {
  const id = (raw as { id?: unknown } | null)?.id;
  return typeof id === "string" && id !== "" ? ` (${JSON.stringify(id)})` : "";
}

export class AcpConfigFile {
  readonly path: string;

  constructor(path: string = defaultAcpConfigPath()) {
    this.path = path;
  }

  /**
   * The agents the file lists; none when there is no file. A file that is there but cannot be
   * read whole (unreadable, not JSON, not a list of agents, or any one agent that does not hold
   * up) throws an `AcpConfigError` naming the file: the caller must not take it for an empty or
   * shorter list, or the next `write` would drop what it could not read.
   */
  read(): AcpAgentConfig[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw new AcpConfigError(
        this.path,
        `cannot be read: ${messageOf(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new AcpConfigError(
        this.path,
        `is not valid JSON: ${messageOf(error)}`,
      );
    }
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? (parsed as { agents?: unknown }).agents
        : undefined;
    if (!Array.isArray(list))
      throw new AcpConfigError(
        this.path,
        `does not hold a list of agents: it should be { "agents": [ ... ] }`,
      );
    const agents: AcpAgentConfig[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of list.entries()) {
      let agent: AcpAgentConfig;
      try {
        agent = checkAcpAgent(raw);
      } catch (error) {
        throw new AcpConfigError(
          this.path,
          `agent ${index + 1}${describe(raw)}: ${messageOf(error)}`,
        );
      }
      if (seen.has(agent.id))
        throw new AcpConfigError(this.path, `${agent.id} is listed twice`);
      seen.add(agent.id);
      agents.push(agent);
    }
    return agents;
  }

  get(id: string): AcpAgentConfig | undefined {
    return this.read().find((agent) => agent.id === id);
  }

  /** Replace the file. The env may hold credentials, so it is the user's alone to read. */
  write(agents: readonly AcpAgentConfig[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ agents }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}
