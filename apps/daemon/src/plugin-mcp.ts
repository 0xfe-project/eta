/**
 * A plugin's MCP servers in a session on eta's own loop: `eta.platform.mcp.<server>.<tool>(input)`.
 *
 * They are reached from a script and never as tools of their own, so what a plugin brings does not
 * lengthen the model's tool list. What the model knows of them is in `esmrun`'s description, and
 * that text stays within {@link DTS_CHARS} however many tools there are: a server is described in
 * full, by the names of its tools, or by the count of them, whichever fits, and `$tools` reads the
 * rest when it is wanted.
 *
 * Servers start on first use, so at the start of a session the tools of one that never ran are not
 * known; a call needs no list, and `$tools` starts the server to read one. What a server listed is
 * kept on disk under the plugin's contents, so from the second session on the description has it.
 *
 * The servers are the ones an external runtime would get, from the same place (`sessionServers`).
 */
import type { PlatformEntry, PlatformGroup } from "@eta/harness";
import type { McpServerSpec, McpTool } from "@eta/mcp";
import type { ActivePlugin } from "./plugin-launch";
import { join } from "node:path";
import { schemaToTs } from "@eta/harness";
import { McpError, McpServers } from "@eta/mcp";
import { sessionServers } from "./plugin-launch";

/** The most the servers add to `esmrun`'s description. */
export const DTS_CHARS = 6000;
/** Tool names one server shows when it cannot show more. */
const NAMES_SHOWN = 40;
const DOC_CHARS = 160;
const LIST_TOOLS = "$tools";

/** Answering these with a call would make a server a thenable, or something that prints oddly. */
const notTools = new Set([
  "then",
  "toJSON",
  ...Object.getOwnPropertyNames(Object.prototype),
]);

const IDENTIFIER = /^[A-Z_$][\w$]*$/i;

const doc = (text: string): string => {
  const line = text.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim();
  return line.length > DOC_CHARS ? `${line.slice(0, DOC_CHARS - 1)}…` : line;
};

const keyOf = (name: string): string =>
  IDENTIFIER.test(name) ? name : JSON.stringify(name);

/** A server's name as a script writes it; two that would read the same are told apart. */
function identifiers(names: readonly string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const base = name.replace(/\W/g, "_");
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
    seen.add(id);
    return id;
  });
}

interface Described {
  name: string;
  /** What the plugin says of itself. */
  about: string;
  tools: readonly McpTool[] | undefined;
}

function signature(tool: McpTool): string {
  const input = schemaToTs(tool.inputSchema, "          ");
  const output =
    tool.outputSchema === undefined
      ? "string"
      : schemaToTs(tool.outputSchema, "          ");
  const line = doc(tool.description);
  return `${line === "" ? "" : `          /** ${line} */\n`}          ${keyOf(tool.name)}(input: ${input}): Promise<${output}>;`;
}

/** One server at each level of detail, least first. */
function levels(server: Described): string[] {
  const { name, about, tools } = server;
  const comment = (text: string): string =>
    `        /** ${[doc(about), text].filter((one) => one !== "").join(" ")} */\n        ${name}: any;`;
  if (tools === undefined)
    return [comment(`Tools not read yet: \`${LIST_TOOLS}()\` starts it.`)];
  const count = `${tools.length} tools; \`${LIST_TOOLS}()\` reads them.`;
  const shown = tools.slice(0, NAMES_SHOWN).map((tool) => tool.name);
  const more = tools.length - shown.length;
  return [
    comment(count),
    comment(
      `${tools.length} tools, \`${LIST_TOOLS}({ tool })\` reads one: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
    ),
    [
      ...(about === "" ? [] : [`        /** ${doc(about)} */`]),
      `        ${name}: {`,
      ...tools.map(signature),
      "        };",
    ].join("\n"),
  ];
}

/**
 * The servers as declarations within `budget`. Everyone starts at the least detail; the smallest
 * step up goes first, so one enormous server does not cost the others their signatures.
 */
export function mcpDeclarations(
  servers: readonly Described[],
  budget: number = DTS_CHARS,
): string {
  const head = [
    `      /** MCP tools of this session's plugins, through \`import eta from "eta"\`. A server starts on first use. A tool takes one object and resolves to its structured result or its text; a tool error, a crash or a failed start rejects. \`eta.platform.mcp.<server>.${LIST_TOOLS}({ tool? })\` reads a server's tools with their schemas. */`,
    "      mcp: {",
  ];
  const tail = ["      };"];
  const room = budget - [...head, ...tail].join("\n").length;
  const chosen = servers.map(levels);
  const level = chosen.map(() => 0);
  const used = (): number =>
    chosen.reduce((sum, texts, at) => sum + texts[level[at]!]!.length + 1, 0);
  for (const step of [1, 2])
    for (const at of chosen
      .map((_, index) => index)
      .sort(
        (a, b) =>
          (chosen[a]![step]?.length ?? 0) - (chosen[b]![step]?.length ?? 0),
      )) {
      const text = chosen[at]![step];
      if (text === undefined) continue;
      const before = level[at]!;
      level[at] = step;
      if (used() > room) level[at] = before;
    }
  const lines: string[] = [];
  let left = room;
  for (const [at, texts] of chosen.entries()) {
    const text = texts[level[at]!]!;
    if (text.length + 1 > left - 80) {
      lines.push(
        `        // and ${chosen.length - at} more servers: \`Object.keys(eta.platform.mcp)\``,
      );
      break;
    }
    lines.push(text);
    left -= text.length + 1;
  }
  return [...head, ...lines, ...tail].join("\n");
}

export interface PluginMcpOptions {
  dataDir: string;
  /** The session's directory: what a tool returns that is not text is written under it. */
  sessionDir: string;
  /** Takes the secrets a session must not see out of what a server says. */
  clean: <T>(value: T) => T;
  warn: (message: string) => void;
}

/** The session's servers as a platform group; `undefined` when its plugins have none. */
export async function pluginPlatformGroup(
  plugins: readonly ActivePlugin[],
  options: PluginMcpOptions,
): Promise<PlatformGroup | undefined> {
  const { dataDir, sessionDir, clean, warn } = options;
  const found: {
    spec: McpServerSpec;
    about: string;
    hash: string;
  }[] = [];
  for (const { plugin, config, hash } of plugins)
    for (const spec of await sessionServers(plugin, dataDir, config, warn))
      found.push({
        spec,
        about: plugin.manifest.description ?? "",
        hash,
      });
  if (found.length === 0) return undefined;
  const ids = identifiers(found.map(({ spec }) => spec.name));
  const named = found.map((server, at) => ({
    ...server,
    spec: { ...server.spec, name: ids[at]! },
    origin: server.spec.name,
  }));
  const servers = new McpServers({
    servers: named.map(({ spec }) => spec),
    cacheDir: join(dataDir, "plugin-runtime", "mcp-tools"),
    // By contents: another version of a plugin is another list. Values do not go into the key, so
    // nothing derived from a secret is on disk.
    cacheKey: (spec) => {
      const server = named.find((one) => one.spec.name === spec.name)!;
      return `${server.hash}:${server.origin}`;
    },
    outputDir: join(sessionDir, "mcp-output"),
    clean,
  });

  const member = (server: string): PlatformEntry => ({
    keys: () => [
      ...(servers.known(server) ?? []).map((tool) => tool.name),
      LIST_TOOLS,
    ],
    get: (name) => {
      if (name === LIST_TOOLS)
        return async (input) => {
          const { tool } = input as { tool?: string };
          const tools = servers.known(server) ?? (await servers.tools(server));
          if (tool === undefined) return tools;
          const one = tools.find((candidate) => candidate.name === tool);
          if (one === undefined)
            throw new McpError(
              "unavailable",
              `${server} has no tool ${tool}; it has ${tools.map((t) => t.name).join(", ") || "none"}`,
            );
          return one;
        };
      if (
        notTools.has(name) &&
        servers.known(server)?.some((tool) => tool.name === name) !== true
      )
        return undefined;
      return async (input, context) =>
        await servers.call(server, name, input, {
          signal: context?.signal,
        });
    },
  });

  return {
    name: "mcp",
    root: {
      keys: () => servers.names,
      get: (name) => (servers.names.includes(name) ? member(name) : undefined),
    },
    declarations: () =>
      mcpDeclarations(
        named.map(({ spec, about }) => ({
          name: spec.name,
          about,
          tools: servers.known(spec.name),
        })),
      ),
    close: async () => {
      await servers.close();
    },
  };
}
