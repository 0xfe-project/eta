import type { PluginAgentLevel, PluginValue } from "@eta/client-contracts";
import type { SessionMeta } from "@eta/server";
import type { SshTransport } from "@eta/ssh";
import type { SessionHooks } from "../session-hooks";
import type { Plugins } from "./service";
import { Buffer } from "node:buffer";
import { posix } from "node:path";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { shellQuote } from "@eta/ssh";
import { Type } from "typebox";

/**
 * `get_plugin_config`: how an agent reads what the user configured for a plugin it has enabled.
 *
 * What comes back for a field depends on its level, and the rule that matters is what stays out:
 * a `none` or `file` value is never in the result, because a tool result is what the model reads
 * and the journal keeps. `file` writes the value on the machine the session runs on and returns the
 * path. Every read of a secret is audited, without the value.
 */

/** How long a `file` value lasts; the next read on that machine sweeps older ones too. */
const FILE_TTL_MINUTES = 60;
const FILE_PREFIX = "eta-plugin-";

/** Fresh private directory, file 0600, value on stdin so it is not in any process's arguments. */
const writeScript = `umask 077
base="\${TMPDIR:-/tmp}"
find "$base" -maxdepth 1 -type d -name '${FILE_PREFIX}*' -user "$(id -u)" -mmin +${FILE_TTL_MINUTES} -exec rm -rf {} + 2>/dev/null
dir=$(mktemp -d "$base/${FILE_PREFIX}XXXXXX") || exit 1
cat > "$dir/value" || exit 1
printf '%s' "$dir/value"`;

async function writeValueFile(
  transport: SshTransport,
  value: string,
): Promise<string> {
  const result = await transport.run(writeScript, {
    input: Buffer.from(value, "utf8"),
    timeoutMs: 15_000,
  });
  if (result.code !== 0 || result.stdout === "")
    throw new Error(result.stderr.trim() || "the file could not be written");
  const path = result.stdout.trim();
  // Gone within the hour even if nothing else reads a value on that machine.
  setTimeout(
    () => {
      void transport
        .run(`rm -rf ${shellQuote(posix.dirname(path))}`)
        .catch(() => undefined);
    },
    FILE_TTL_MINUTES * 60 * 1000,
  ).unref();
  return path;
}

type FieldResult =
  | { level: "read" | "value"; value: PluginValue | null }
  | { level: "file"; path: string; expiresInMinutes: number }
  | { level: "file" | "value" | "read"; error: string }
  | { level: "none"; readable: false; note: string };

const NOT_READABLE =
  "Not readable. The plugin's own MCP server already receives this value; use its tools.";

export function pluginSessionTools(deps: {
  plugins: Plugins;
  /** A way to run a script on the machine a session runs on. */
  transportOf: (meta: SessionMeta) => SshTransport;
}): NonNullable<SessionHooks["sessionTools"]> {
  return ({ meta }) => {
    const { agentId } = meta;
    if (agentId === undefined) return [];
    const read = async (
      plugin: string,
      level: PluginAgentLevel,
      name: string,
      value: PluginValue | undefined,
    ): Promise<FieldResult> => {
      if (level === "none")
        return { level, readable: false, note: NOT_READABLE };
      if (level === "read") return { level, value: value ?? null };
      if (typeof value !== "string")
        return { level, error: "This field has no value." };
      const audit = (): void =>
        deps.plugins.audited({
          sessionId: meta.id,
          agentId,
          plugin,
          field: name,
          level,
        });
      if (level === "value") {
        audit();
        return { level, value };
      }
      try {
        const path = await writeValueFile(deps.transportOf(meta), value);
        audit();
        return { level, path, expiresInMinutes: FILE_TTL_MINUTES };
      } catch (error) {
        return {
          level,
          error: `Could not write the file on this machine: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const tool = defineTool({
      name: "get_plugin_config",
      label: "Plugin configuration",
      description:
        "Read what the user configured for a plugin you have enabled; never print or repeat a secret it gives you. A field set to `read` or `value` returns its value; `file` returns the path of a private temporary file holding it, so a script can use it without the value entering the conversation; `none` is not readable, because only the plugin's own MCP server receives it.",
      parameters: Type.Object({
        plugin: Type.String({ description: "The plugin's name." }),
        fields: Type.Optional(
          Type.Array(Type.String(), {
            description: "The fields to read; every field when left out.",
          }),
        ),
      }),
      async execute(args) {
        const readable = deps.plugins.readable(agentId, args.plugin);
        if (readable === undefined)
          return toolError(
            `Plugin ${args.plugin} is not enabled for this agent, or needs configuring first. Enabled: ${
              deps.plugins
                .active(agentId)
                .map((entry) => entry.name)
                .join(", ") || "none"
            }.`,
          );
        const wanted =
          args.fields ?? readable.fields.map(({ field }) => field.name);
        const fields: Record<string, FieldResult | { error: string }> = {};
        for (const name of wanted) {
          const found = readable.fields.find(
            ({ field }) => field.name === name,
          );
          fields[name] =
            found === undefined
              ? { error: "No such field." }
              : await read(args.plugin, found.level, name, found.value);
        }
        return text(JSON.stringify({ plugin: args.plugin, fields }, null, 2));
      },
    });
    return [toKernelTool(tool, () => undefined)];
  };
}
