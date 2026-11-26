import type { AcpAgentConfig } from "./acp";
import { ACP_AGENT_ID } from "./acp";

// The external-agent form as text, and back: what the user types (args and env one per line) and
// the config the host stores. Checked here as the host checks it; the host still has the last word.

export interface AcpDraft {
  label: string;
  id: string;
  command: string;
  /** One argument per line. */
  args: string;
  /** One KEY=VALUE per line. */
  env: string;
}

export const emptyAcpDraft: AcpDraft = {
  label: "",
  id: "",
  command: "",
  args: "",
  env: "",
};

export function acpDraftOf(agent: AcpAgentConfig): AcpDraft {
  return {
    label: agent.label,
    id: agent.id,
    command: agent.command,
    args: agent.args.join("\n"),
    env: Object.entries(agent.env)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  };
}

/** An id from a name: lower case, runs of anything else a dash. Empty when nothing is left. */
export function acpSlug(label: string): string {
  return label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Lines, each kept as typed past its surrounding blanks; blank lines dropped. */
function parseAcpArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

export type EnvParse =
  | { ok: true; env: Record<string, string> }
  | { ok: false; line: number; reason: "noEquals" | "emptyKey" | "duplicate" };

/**
 * `KEY=VALUE` lines into a map; the value is everything after the first `=`, so it may hold `=`
 * itself. Blank lines and `#` comments are skipped. The first bad line is reported, 1-based.
 */
export function parseAcpEnv(text: string): EnvParse {
  const env: Record<string, string> = {};
  const lines = text.split("\n");
  for (const [at, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) return { ok: false, line: at + 1, reason: "noEquals" };
    const key = line.slice(0, equals).trim();
    if (key === "") return { ok: false, line: at + 1, reason: "emptyKey" };
    if (Object.hasOwn(env, key))
      return { ok: false, line: at + 1, reason: "duplicate" };
    env[key] = line.slice(equals + 1);
  }
  return { ok: true, env };
}

export type AcpDraftProblems = Partial<
  Record<"label" | "id" | "command" | "env", { key: string; line?: number }>
>;

/**
 * What stops the draft from being saved, by field, as message keys (the web's `acp` namespace; the NSH client maps them to its own); the config
 * to send when nothing does. `taken` are the ids already in use on the same machine, apart from the one being edited:
 * another machine's agents are its own, and may have the same id.
 */
export function checkAcpDraft(
  draft: AcpDraft,
  taken: readonly string[],
):
  | { ok: true; config: AcpAgentConfig }
  | { ok: false; problems: AcpDraftProblems } {
  const problems: AcpDraftProblems = {};
  const id = draft.id.trim();
  if (draft.label.trim() === "")
    problems.label = { key: "errors.labelRequired" };
  if (id === "") problems.id = { key: "errors.idRequired" };
  else if (!ACP_AGENT_ID.test(id)) problems.id = { key: "errors.idFormat" };
  else if (taken.includes(id)) problems.id = { key: "errors.idTaken" };
  if (draft.command.trim() === "")
    problems.command = { key: "errors.commandRequired" };
  const env = parseAcpEnv(draft.env);
  if (!env.ok)
    problems.env = { key: `errors.env.${env.reason}`, line: env.line };
  if (Object.keys(problems).length > 0 || !env.ok)
    return { ok: false, problems };
  return {
    ok: true,
    config: {
      id,
      label: draft.label.trim(),
      command: draft.command.trim(),
      args: parseAcpArgs(draft.args),
      env: env.env,
    },
  };
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/** The command and its arguments as one shell line, each word quoted where a shell would split it. */
export function acpCommandLine(
  agent: Pick<AcpAgentConfig, "command" | "args">,
): string {
  return [agent.command, ...agent.args]
    .map((word) =>
      SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}
