/**
 * The ESM realm, wired into a session (ESMMODE.md, ESMMODE-IMPL.md).
 *
 * One session, one {@link Agent}, one realm. The model reaches it through two
 * tools, `esmrun` and `esmrunandkeep`; everything else the session can do is
 * already in the realm:
 *
 * - every other tool the session has, mirrored as `eta.platform.<name>` from
 *   the live tool table (the same table the provider's tool list and the d.ts
 *   in `esmrun`'s description are read from, so the three cannot drift);
 *   `finish_task` is not mirrored, because it ends the turn;
 * - `eta.platform.llm`, a bare model call;
 * - `eta.state`, the session's journaled KV;
 * - `eta.ask`, a nested turn of this same agent, with tools and the history;
 * - `search` / `view` / `edit` / `$` and `node:*`, resolved in the session cwd.
 *
 * Every script a run evaluates is written to disk first (`runs/`), so the code
 * the model ran is a file, not something that only lived in memory.
 */
import type {
  AgentMessage,
  AssistantMessage,
  Kernel,
  KernelModels,
  Message,
  Runner,
} from "@eta/core";
import type { TSchema } from "typebox";
import type {
  AskRequest,
  AskResult,
  Effect,
  Layer,
  PlatformCall,
} from "./realm";
import type { McpSink } from "./realm/hooks";
import type { StateKV } from "./state";
import type { HarnessTool, ToolResult } from "./tools/tool";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toToolResultMessage } from "@eta/core";
import { Type } from "typebox";
import { convertToLlm } from "./prompts/summaries";
import { Agent, snippetSource } from "./realm";

export const ESM_TOOL_NAMES = [
  "esmrun",
  "esmrunandkeep",
  "list_capabilities",
  "read_state",
] as const;

/** Tools a script cannot call through `eta.platform`. */
const NOT_MIRRORED = new Set<string>([...ESM_TOOL_NAMES, "finish_task"]);

/** Past this, a result goes to a file and the model is handed the path. */
const RESULT_CHARS = 20_000;
/** A nested turn that keeps calling tools is stopped here; the text so far is returned. */
const ASK_TURNS = 50;

export interface EsmSessionOptions {
  kernel: Kernel;
  models: KernelModels;
  /** Read lazily: the runner is built after the tools are registered. */
  runner: () => Runner;
  state: StateKV;
  /** The personal layer: `env.js`, `runs/` and installed packages live here. */
  root: string;
  project?: string | undefined;
  global?: string | undefined;
  /** Where relative paths, `$` and `search` resolve. */
  cwd?: string | undefined;
  /** MCP servers on this machine; absent in remote/daemon sessions. */
  mcp?: McpSink | undefined;
}

export interface EsmSession {
  agent: Agent;
  tools: HarnessTool<unknown, TSchema, unknown>[];
  /** What changed in the capability layers since the last call, as a message; `undefined` if nothing. */
  delta: () => string | undefined;
  dispose: () => void;
}

/** What one tool call that is evaluating a script carries through async calls. */
interface Frame {
  toolCallId: string;
  turn: number;
  signal: AbortSignal | undefined;
  /** `eta.ask` stack above this frame, outermost first. */
  stack: string[];
  console: string[];
  /** Details of the platform calls this script made, for the cards a UI draws. */
  calls: { tool: string; details: unknown; isError: boolean }[];
  asks: { stack: string[]; text: string; status: string }[];
  seq: number;
}
const userMessage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

const textOf = (message: AssistantMessage): string =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

/** A tool result's text, whatever shape the tool answered with. */
function resultText(raw: unknown): {
  text: string;
  isError: boolean;
  details: unknown;
} {
  const message = toToolResultMessage({ id: "", name: "" }, raw) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
    details?: unknown;
  };
  return {
    text: message.content
      .flatMap((part) =>
        part.type === "text" ? [part.text ?? ""] : ["[image]"],
      )
      .join("\n"),
    isError: message.isError === true,
    details: message.details,
  };
}

const show = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const effectLine = (effect: Effect): string =>
  `${effect.status === "ok" ? "" : `[${effect.status}] `}${effect.name} ${effect.detail} (line ${effect.at.line})`;

const IDENTIFIER = /^[A-Z_$][\w$]*$/i;
/** A TypeBox (JSON) schema as a TypeScript type, for the d.ts a model reads. */
export function schemaToTs(schema: unknown, indent = ""): string {
  const s = (schema ?? {}) as Record<string, unknown>;
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum))
    return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  const union = (s.anyOf ?? s.oneOf) as unknown[] | undefined;
  if (Array.isArray(union))
    return union.map((one) => schemaToTs(one, indent)).join(" | ");
  switch (s.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = schemaToTs(s.items, indent);
      return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required ?? []) as string[]);
      const keys = Object.keys(props);
      if (keys.length === 0) return "Record<string, unknown>";
      const inner = `${indent}  `;
      const lines = keys.map((key) => {
        const prop = props[key] as Record<string, unknown>;
        const doc =
          typeof prop.description === "string"
            ? `${inner}/** ${prop.description.replace(/\*\//g, "* /").replace(/\s+/g, " ")} */\n`
            : "";
        const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
        return `${doc}${inner}${name}${required.has(key) ? "" : "?"}: ${schemaToTs(prop, inner)};`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
    default:
      return "unknown";
  }
}

/** The tools a script reaches as `eta.platform.<name>`: every registered tool but ours and `finish_task`. */
function mirrored(kernel: Kernel) {
  return kernel.tools
    .list()
    .filter(
      (tool) => !NOT_MIRRORED.has(tool.name) && IDENTIFIER.test(tool.name),
    );
}

/** The realm's surface as declarations, generated from the live tool table. */
export function platformDts(
  kernel: Kernel,
  mcpServers: readonly string[] = [],
): string {
  const calls = mirrored(kernel).map((tool) => {
    const params = (tool as { parameters?: unknown }).parameters;
    const first =
      (tool.description ?? "").split(/(?<=[.。])\s/)[0]?.trim() ?? "";
    return `    /** ${first.replace(/\*\//g, "* /")} */\n    ${tool.name}(input: ${schemaToTs(params, "    ")}): Promise<string>;`;
  });
  return [
    'declare module "eta" {',
    "  const eta: {",
    "    /** The session's tools as functions. Resolves to the tool's text; a tool error rejects. */",
    "    platform: {",
    ...calls.map((c) => `  ${c.replace(/\n/g, "\n  ")}`),
    "      /** A bare model call: no tools, no history. */",
    "      llm(input: { prompt: string; system?: string }): Promise<string>;",
    "    };",
    "    /** A nested turn of this agent: same tools, the session history so far. Concurrent calls run in parallel (5 at a time). */",
    '    ask(prompt: string): Promise<{ text: string; effects: unknown[]; stack: string[]; status: "completed" | "cancelled"; warning?: string }>;',
    "    /** A plain object for values that reach the next call: `eta.state.x = y`, any value. Top-level const does not carry over. JSON-able values are saved with the session; the rest (functions, connections) live until the session closes. */",
    "    state: Record<string, any>;",
    "    /** Persist a function as a capability in this layer's env.js. */",
    "    define(name: string, fn: (...args: any[]) => unknown, meta?: { desc?: string }): string;",
    "    /** Capabilities defined in this layer. */",
    "    modules: Record<string, (...args: any[]) => any>;",
    ...(mcpServers.length === 0
      ? []
      : [
          "    /** MCP discovery from cached metadata; none of these start a server. */",
          "    mcp: {",
          "      servers(): { name: string; status: string; toolCount: number }[];",
          "      search(query: string): { server: string; tool: string; summary: string }[];",
          '      /** A server\'s tools as a d.ts: `declare module "mcp:<server>"` with input and output types. */',
          "      describe(server: string): string;",
          "    };",
        ]),
    "  };",
    "  export default eta;",
    "}",
    ...mcpServers.map(
      (name) =>
        `declare module ${JSON.stringify(`mcp:${name}`)} { const tools: Record<string, (input?: object) => Promise<any>>; export default tools; }`,
    ),
    "/** ripgrep; paths relative to the session cwd. */",
    "declare function search(pattern: string, options?: { glob?: string; cwd?: string; limit?: number }): Promise<{ file: string; line: number; column?: number; text: string; match?: string }[]>;",
    "/** Lines with 1-indexed `N: ` prefixes. Defaults: start 1, limit 50. */",
    "declare function view(path: string, options?: { start?: number; limit?: number }): Promise<string>;",
    "/** Replace exactly one occurrence of oldText; zero or several matches throw. */",
    "declare function edit(path: string, oldText: string, newText: string): Promise<void>;",
    "/** zx lite, in the session cwd: await $`cmd`, .nothrow(), .quiet(), .timeout('5s'), .pipe(). */",
    "declare const $: any;",
  ].join("\n");
}
/**
 * The transcript as a nested turn sends it: the call that is running this very
 * script has no result yet, and a provider refuses a tool call without one.
 */
function askHistory(transcript: readonly AgentMessage[]): Message[] {
  const messages = convertToLlm(transcript);
  const answered = new Set(
    messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : [])),
  );
  const open: Message[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const part of m.content) {
      if (part.type !== "toolCall" || answered.has(part.id)) continue;
      open.push({
        role: "toolResult",
        toolCallId: part.id,
        toolName: part.name,
        content: [
          {
            type: "text",
            text: "(still running: this nested turn was started from inside this call)",
          },
        ],
        isError: false,
        timestamp: Date.now(),
      } as Message);
    }
  }
  return [...messages, ...open];
}

const ESMRUN_DESCRIPTION = [
  "Run JavaScript in this session's ESM realm. The script is a module (imports, top-level await); its last expression is the result, or `export default` it. Relative paths, `$` and `search` resolve in the session cwd. Every script is saved under the session's runs/ directory.",
  'Prefer search/view/edit over `$` for files. Bare imports (`import pg from "pg"`) are installed from npm on first use.',
  "Default to esmrun; use esmrunandkeep only for something you will call again.",
].join(" ");

/** `esmrun`'s description: the fixed text plus the realm's surface, read from the live tool table. */
export function esmrunDescription(
  kernel: Kernel,
  mcpServers: readonly string[] = [],
): string {
  return `${ESMRUN_DESCRIPTION}\n\nThe realm:\n\`\`\`ts\n${platformDts(kernel, mcpServers)}\n\`\`\``;
}
export function openEsmSession(options: EsmSessionOptions): EsmSession {
  const { kernel, models, state, root } = options;
  const frames = new AsyncLocalStorage<Frame>();
  // The eta.ask stack a tool call runs under; empty at the top of the session.
  const askStack = new AsyncLocalStorage<string[]>();

  const modelOf = () => {
    const { provider, modelId } = kernel.config.read("model");
    const model = models.getModel(provider, modelId);
    if (model === undefined)
      throw new Error(`model_unavailable: ${provider}/${modelId}`);
    return model;
  };

  const platform = (): Record<string, PlatformCall> => {
    const calls: Record<string, PlatformCall> = {};
    for (const tool of mirrored(kernel)) {
      calls[tool.name] = async (input: unknown) => {
        const frame = frames.getStore();
        const raw = await kernel.tools.execute(tool.name, input ?? {}, {
          turn: frame?.turn ?? kernel.turns,
          toolCallId: `${frame?.toolCallId ?? "esm"}.${tool.name}.${frame === undefined ? 0 : ++frame.seq}`,
          ...(frame?.signal === undefined ? {} : { signal: frame.signal }),
        });
        const result = resultText(raw);
        frame?.calls.push({
          tool: tool.name,
          details: result.details,
          isError: result.isError,
        });
        if (result.isError) throw new Error(`${tool.name}: ${result.text}`);
        return result.text;
      };
    }
    calls.llm = async (input: unknown) => {
      const { prompt, system } = (input ?? {}) as {
        prompt?: string;
        system?: string;
      };
      if (typeof prompt !== "string")
        throw new TypeError("eta.platform.llm expects { prompt: string }");
      const signal = frames.getStore()?.signal;
      const reply = await models.completeSimple(
        modelOf(),
        {
          ...(system === undefined ? {} : { systemPrompt: system }),
          messages: [userMessage(prompt)],
        },
        signal === undefined ? {} : { signal },
      );
      if (reply.stopReason === "error")
        throw new Error(reply.errorMessage ?? "llm call failed");
      return textOf(reply);
    };
    calls.llm.kind = "cost";
    return calls;
  };
  /**
   * `eta.ask`: a nested turn of this agent. It starts from the session history
   * as it stands (the calls still running get a placeholder result), sees the
   * same tools, and loops until the model stops calling them. Concurrent asks
   * do not see each other. The stack it ran under goes back to the caller and
   * into the esmrun result, which is how it reaches the session history.
   */
  const ask = async (request: AskRequest): Promise<AskResult> => {
    const frame = frames.getStore();
    const stack = [
      ...(askStack.getStore() ?? []),
      ...(request.parentStack ?? []),
    ];
    const signal = frame?.signal;
    const state = await options.runner().requestState();
    const header = `[eta.ask depth ${stack.length}] ${stack.join(" > ")}`;
    const messages: Message[] = [
      ...askHistory(options.runner().getTranscript()),
      userMessage(`${header}\n\n${request.prompt}`),
    ];
    let text = "";
    let status: AskResult["status"] = "completed";
    for (let turn = 0; ; turn++) {
      if (signal?.aborted === true || turn >= ASK_TURNS) {
        status = "cancelled";
        break;
      }
      const reply = await models.completeSimple(
        modelOf(),
        { systemPrompt: state.systemPrompt, messages, tools: state.tools },
        signal === undefined ? {} : { signal },
      );
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        status = "cancelled";
        text = textOf(reply) || (reply.errorMessage ?? "");
        break;
      }
      messages.push(reply);
      text = textOf(reply);
      const toolCalls = reply.content.filter(
        (part) => part.type === "toolCall",
      );
      if (toolCalls.length === 0) break;
      for (const call of toolCalls) {
        if (call.type !== "toolCall") continue;
        const raw = await askStack.run(stack, () =>
          kernel.tools.execute(call.name, call.arguments, {
            turn: kernel.turns,
            toolCallId: call.id,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
        messages.push(toToolResultMessage(call, raw) as Message);
      }
    }
    const result: AskResult = {
      text: `${header}\n${text}`,
      effects: [],
      stack,
      status,
      ...(stack.length >= 10
        ? {
            warning: `eta.ask recursion depth is ${stack.length}; consider returning a result instead of asking again`,
          }
        : {}),
    };
    frame?.asks.push({ stack, text, status });
    return result;
  };

  // `eta.state`: one host object for the session, so it outlives a realm rebuilt after a
  // define. It is filled from the session KV before the first run, and after every run
  // the JSON-able keys are written back (a key that is gone is deleted).
  const etaState: Record<string, unknown> = {};
  const persisted = new Map<string, string>();
  let hydrated: Promise<void> | undefined;
  const hydrate = (): Promise<void> =>
    (hydrated ??= (async () => {
      for (const key of await state.keys()) {
        const raw = await state.get(key);
        if (raw === undefined) continue;
        persisted.set(key, raw);
        try {
          etaState[key] = JSON.parse(raw);
        } catch {
          etaState[key] = raw; // written before eta.state took any value
        }
      }
    })());
  const flush = async (): Promise<void> => {
    for (const [key, value] of Object.entries(etaState)) {
      let json: string | undefined;
      try {
        json = typeof value === "function" ? undefined : JSON.stringify(value);
      } catch {
        json = undefined; // a cycle, a BigInt: kept in memory only
      }
      if (json === undefined) {
        if (persisted.has(key)) {
          await state.set(key, null);
          persisted.delete(key);
        }
        continue;
      }
      if (persisted.get(key) !== json) {
        await state.set(key, json);
        persisted.set(key, json);
      }
    }
    for (const key of [...persisted.keys()])
      if (!Object.hasOwn(etaState, key)) {
        await state.set(key, null);
        persisted.delete(key);
      }
  };

  /** The MCP sink with the running script's signal and a per-call id, like `eta.platform`. */
  const frameMcp = (sink: McpSink): McpSink => ({
    servers: () => sink.servers(),
    load: (server) => sink.load(server),
    search: (query) => sink.search(query),
    describe: (server) => sink.describe(server),
    callTool: (server, tool, args) => {
      const frame = frames.getStore();
      return sink.callTool(server, tool, args, {
        toolCallId: `${frame?.toolCallId ?? "esm"}.mcp.${server}.${tool.name}.${frame === undefined ? 0 : ++frame.seq}`,
        ...(frame?.signal === undefined ? {} : { signal: frame.signal }),
      });
    },
  });

  const agent = new Agent({
    root,
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.global === undefined ? {} : { global: options.global }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    hooks: {
      platform,
      state: etaState,
      ask,
      ...(options.mcp === undefined ? {} : { mcp: frameMcp(options.mcp) }),
      onConsole: (level, line) => {
        frames
          .getStore()
          ?.console.push(level === "log" ? line : `[${level}] ${line}`);
      },
    },
  });
  const runsDir = join(root, "runs");
  const capsDir = join(root, "capabilities");

  /** Evaluate one script under a frame, and turn what happened into the tool's result. */
  const evaluate = async (
    source: string,
    file: string,
    call: {
      toolCallId: string;
      turn: number;
      signal?: AbortSignal | undefined;
    },
    timeoutMs: number | undefined,
  ): Promise<ToolResult> => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source, "utf8");
    const frame: Frame = {
      toolCallId: call.toolCallId,
      turn: call.turn,
      signal: call.signal,
      stack: askStack.getStore() ?? [],
      console: [],
      calls: [],
      asks: [],
      seq: 0,
    };
    const parts: string[] = [];
    let isError = false;
    let effects: Effect[] = [];
    await hydrate();
    await frames.run(frame, async () => {
      try {
        const realm = agent.realm();
        const module = snippetSource(source, (s) => realm.parses(s));
        const result = await agent.run(module, {
          identifier: file,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        effects = result.effects;
        parts.push(show(result.value));
      } catch (error) {
        isError = true;
        parts.push(
          `Error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    });
    try {
      await flush();
    } catch (error) {
      parts.push(
        `(eta.state was not saved: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
    let text = parts.join("\n");
    if (text.length > RESULT_CHARS) {
      const full = `${file.replace(/\.js$/, "")}.out.txt`;
      writeFileSync(full, text, "utf8");
      text = `${text.slice(0, RESULT_CHARS)}\n… (${text.length} chars; full output: ${full})`;
    }
    const sections = [text];
    if (frame.console.length > 0)
      sections.push(`console:\n${frame.console.join("\n")}`);
    for (const one of frame.asks)
      sections.push(`eta.ask [${one.status}] ${one.stack.join(" > ")}`);
    if (effects.length > 0)
      sections.push(`effects:\n${effects.map(effectLine).join("\n")}`);
    sections.push(`script: ${file}`);
    return {
      content: [{ type: "text", text: sections.join("\n\n") }],
      details: {
        file,
        effects,
        calls: frame.calls,
        asks: frame.asks,
        stack: frame.stack,
      },
      ...(isError ? { isError: true } : {}),
    };
  };
  /** Every capability in every layer, as `layer:name` → source, for the delta. */
  const snapshot = (): Map<string, { source: string; desc: string }> => {
    agent.layers.reload();
    const out = new Map<string, { source: string; desc: string }>();
    for (const layer of ["self", "project", "global"] as Layer[]) {
      for (const cap of agent.layers.get(layer)?.capabilities ?? [])
        out.set(`${layer}:${cap.name}`, {
          source: cap.source,
          desc: cap.meta.desc ?? "",
        });
    }
    return out;
  };
  let seen: Map<string, { source: string; desc: string }> | undefined;
  const delta = (): string | undefined => {
    const now = snapshot();
    const before = seen;
    seen = now;
    if (before === undefined) return undefined;
    const line = (key: string, desc: string) =>
      `- ${key}${desc === "" ? "" : `: ${desc}`}`;
    const added = [...now]
      .filter(([k]) => !before.has(k))
      .map(([k, v]) => line(k, v.desc));
    const changed = [...now]
      .filter(([k, v]) => before.has(k) && before.get(k)!.source !== v.source)
      .map(([k, v]) => line(k, v.desc));
    const removed = [...before.keys()]
      .filter((k) => !now.has(k))
      .map((k) => `- ${k}`);
    if (added.length + changed.length + removed.length === 0) return undefined;
    return [
      "## Capability delta",
      ...(added.length === 0 ? [] : ["", "Added capabilities:", ...added]),
      ...(changed.length === 0
        ? []
        : ["", "Changed capabilities:", ...changed]),
      ...(removed.length === 0
        ? []
        : ["", "Removed capabilities:", ...removed]),
    ].join("\n");
  };

  const stamp = (call: { turn: number; toolCallId: string }) =>
    `${String(call.turn).padStart(4, "0")}-${call.toolCallId.replace(/[^\w.-]/g, "_")}`;

  const esmrun: HarnessTool<unknown, TSchema, unknown> = {
    name: "esmrun",
    label: "esmrun",
    get description() {
      return esmrunDescription(
        kernel,
        options.mcp?.servers().map((server) => server.name) ?? [],
      );
    },
    parameters: Type.Object({
      script: Type.String({
        description:
          "The module source. Its last expression (or default export) is the result.",
      }),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Synchronous-evaluation timeout; default 10000.",
        }),
      ),
    }),
    async execute(args, run) {
      const { script, timeoutMs } = args as {
        script: string;
        timeoutMs?: number;
      };
      return evaluate(
        script,
        join(runsDir, `${stamp(run.call)}.js`),
        run.call,
        timeoutMs,
      );
    },
  };
  const esmrunandkeep: HarnessTool<unknown, TSchema, unknown> = {
    name: "esmrunandkeep",
    label: "esmrunandkeep",
    description:
      'Save a module as a capability of this session and run it once now. `script` exports a function (default, or `entry`); it is called with `args`. If the run throws, nothing is saved. A name already taken is refused: read the old one and pick another name. Saved capabilities are imported as `import f from "eta:<name>"` or reached as `eta.modules.<name>`. Use esmrun for one-off work.',
    parameters: Type.Object({
      name: Type.String({
        description: "A JavaScript identifier; the capability's name.",
      }),
      desc: Type.String({ description: "One line: what it does." }),
      script: Type.String({
        description: "Full module source; this is what is saved.",
      }),
      args: Type.Optional(
        Type.Unknown({ description: "Passed to the function for this run." }),
      ),
      entry: Type.Optional(
        Type.String({ description: "The export to call; default `default`." }),
      ),
    }),
    async execute(raw, run) {
      const args = raw as {
        name: string;
        desc: string;
        script: string;
        args?: unknown;
        entry?: string;
      };
      if (!IDENTIFIER.test(args.name))
        return {
          content: [
            {
              type: "text",
              text: `name must be a JavaScript identifier: ${args.name}`,
            },
          ],
          isError: true,
        };
      const entry = args.entry ?? "default";
      // The module file is named by its content: a different script is a different file, so
      // writing it never clobbers a capability that already has the name. `eta.define` then
      // decides, by its own rule, whether the name is free (same source is a no-op).
      const hash = createHash("sha256")
        .update(args.script)
        .digest("hex")
        .slice(0, 12);
      const file = join(capsDir, `${args.name}.${hash}.js`);
      const existed = existsSync(file);
      mkdirSync(capsDir, { recursive: true });
      writeFileSync(file, args.script, "utf8");
      // A function written into the wrapper module, not a string: a string is compiled
      // outside any module and has no dynamic import. Its literals keep `toString()` (what
      // define persists) free of outside names.
      const source = `async (...args) => (await import(${JSON.stringify(file)}))[${JSON.stringify(entry)}](...args)`;
      // The run goes first; only a run that got through reaches `eta.define`. The define is a
      // realm call like any other: it is in the ledger, and it updates the registry at once.
      const wrapper = [
        `import eta from "eta";`,
        `import * as m from ${JSON.stringify(file)};`,
        `const f = m[${JSON.stringify(entry)}];`,
        `const value = typeof f === "function" ? await f(${JSON.stringify(args.args ?? {})}) : f;`,
        `eta.define(${JSON.stringify(args.name)}, ${source}, ${JSON.stringify({ desc: args.desc })});`,
        `export default value;`,
      ].join("\n");
      const result = await evaluate(
        wrapper,
        join(runsDir, `${stamp(run.call)}.js`),
        run.call,
        undefined,
      );
      if (result.isError === true) {
        if (!existed) rmSync(file, { force: true });
        return result;
      }
      const first = result.content[0] as { type: "text"; text: string };
      return {
        ...result,
        content: [
          {
            type: "text",
            text: `saved ${args.name} (${file})\n\n${first.text}`,
          },
        ],
      };
    },
  };

  const listCapabilities: HarnessTool<unknown, TSchema, unknown> = {
    name: "list_capabilities",
    label: "list_capabilities",
    description:
      "List the saved capabilities in every layer (self, project, global) with their descriptions.",
    parameters: Type.Object({}),
    execute() {
      const lines = [...snapshot()].map(
        ([k, v]) => `- ${k}${v.desc === "" ? "" : `: ${v.desc}`}`,
      );
      return {
        content: [
          {
            type: "text",
            text:
              lines.length === 0 ? "(no capabilities yet)" : lines.join("\n"),
          },
        ],
      };
    },
  };

  const readState: HarnessTool<unknown, TSchema, unknown> = {
    name: "read_state",
    label: "read_state",
    description:
      "Read eta.state: one key's value, or every key when `key` is absent. Writing is `eta.state.x = y` in esmrun.",
    parameters: Type.Object({ key: Type.Optional(Type.String()) }),
    async execute(raw) {
      const { key } = raw as { key?: string };
      await hydrate();
      const line = (k: string): string => {
        const v = etaState[k];
        const saved = persisted.has(k) ? "" : " (not saved: not JSON)";
        return `${k}: ${typeof v === "function" ? "[function]" : show(v)}${saved}`;
      };
      const text =
        key !== undefined
          ? Object.hasOwn(etaState, key)
            ? line(key)
            : `(${key} is not set)`
          : Object.keys(etaState).length === 0
            ? "(state is empty)"
            : Object.keys(etaState).sort().map(line).join("\n");
      return { content: [{ type: "text", text }] };
    },
  };

  // The baseline for the first delta: what existed when the session opened is not news.
  seen = snapshot();

  return {
    agent,
    tools: [esmrun, esmrunandkeep, listCapabilities, readState],
    delta,
    dispose: () => agent.dispose(),
  };
}
