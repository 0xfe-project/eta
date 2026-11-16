/**
 * `~/.eta/acp.json`: the ACP agents this machine runs, as the user configured them.
 *
 * The file is `{ "agents": AcpAgentConfig[] }`. It is read every time it is asked for (it is a
 * few lines, and the user may edit it by hand), and written whole. An entry that does not hold
 * up is left out with a warning rather than failing the others.
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
  if (value.cwd !== undefined && typeof value.cwd !== "string")
    throw new Error("cwd is a path");
  if (value.autoAllow !== undefined && typeof value.autoAllow !== "boolean")
    throw new Error("autoAllow is true or false");
  const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
  return {
    id,
    label,
    command,
    args: [...((value.args as string[] | undefined) ?? [])],
    env,
    ...(cwd === "" ? {} : { cwd }),
    ...(value.autoAllow === true ? { autoAllow: true } : {}),
  };
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export class AcpConfigFile {
  readonly path: string;
  readonly #warn: (message: string) => void;

  constructor(
    path: string = defaultAcpConfigPath(),
    warn: (message: string) => void = () => undefined,
  ) {
    this.path = path;
    this.#warn = warn;
  }

  /** The agents the file lists; none when there is no file. */
  read(): AcpAgentConfig[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        this.#warn(
          `[eta-runtime-acp] could not read ${this.path}: ${String(error)}`,
        );
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.#warn(
        `[eta-runtime-acp] ${this.path} is not JSON: ${String(error)}`,
      );
      return [];
    }
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(list)) return [];
    const agents: AcpAgentConfig[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
      try {
        const agent = checkAcpAgent(raw);
        if (seen.has(agent.id)) throw new Error(`${agent.id} is listed twice`);
        seen.add(agent.id);
        agents.push(agent);
      } catch (error) {
        this.#warn(
          `[eta-runtime-acp] ${this.path}: skipped an agent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
