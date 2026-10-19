/**
 * Streaming rules: time-traveling stream rules (omp's TTSR) as an akhook rule kind.
 *
 * A `stream` rule watches what the model is generating, accumulated across stream frames, and
 * when it matches it can stop the generation: the kernel throws the partial output away, the
 * rule's message goes in as a reminder, and the same turn generates again. Which surfaces a rule
 * watches (`scope`), whether a match interrupts (`interrupt_mode`), and how often it may fire
 * (`repeat_mode`, `repeat_gap`) are omp's, under akhook's snake_case.
 *
 * A rule that must not interrupt (`never`, or `prose-only`/`tool-only` on the other kind of
 * output) is a soft reminder instead: it waits and is attached to the next tool result (the
 * result of the very call that matched, for a tool-call match), so the model reads it alongside
 * what the tool said. It counts as fired when it is delivered.
 *
 * What fired is the session's: `{ turns, injected }` is saved through the `TriggerStore` and
 * restored when the session opens, so a rule that already fired once does not fire again after a
 * restart, and a reminder stays remembered however the context is compacted.
 */
import type { GenerationFrame, GenerationInterrupt } from "@eta/core";
import type { StreamRule } from "./rules";
import { isAbsolute, relative, resolve } from "node:path";
import { astMatches, languageForPath, normalizeLanguage } from "./ast";

/** What survives a restart: the completed-turn count and when each rule last fired. */
export interface StreamState {
  turns: number;
  injected: Record<string, number>;
}

export interface TriggerStore {
  load: () => Promise<StreamState | undefined>;
  save: (state: StreamState) => void | Promise<void>;
}

export interface StreamRulesOptions {
  /** The rules in force now; read at every frame, so a changed configuration applies at once. */
  rules: () => readonly StreamRule[];
  /** The session's working directory, to resolve the paths a tool call names. */
  cwd: string;
  store?: TriggerStore | undefined;
  warn?: ((message: string) => void) | undefined;
}

type Source = "text" | "thinking" | "tool";

interface Surface {
  source: Source;
  /** Lower-cased tool name, for tool output. */
  tool?: string;
  /** Candidate spellings of the file the call touches. */
  paths: string[];
}

/** The accumulated output of one block of the generation. */
interface Buffer {
  text: string;
  /** For tool output: the call, as far as it is known. */
  surface: Surface;
}

/** The text an `edit` or `write` call introduces, and the file it names. */
export function toolDigest(
  name: string,
  args: unknown,
): { path?: string; digest?: string } {
  if (typeof args !== "object" || args === null) return {};
  const record = args as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path : undefined;
  let digest: string | undefined;
  if (name === "write" && typeof record.content === "string")
    digest = record.content;
  else if (name === "edit") {
    const texts: string[] = [];
    if (Array.isArray(record.edits)) {
      for (const edit of record.edits) {
        const text = (edit as { newText?: unknown } | null)?.newText;
        if (typeof text === "string") texts.push(text);
      }
    }
    if (typeof record.newText === "string") texts.push(record.newText);
    digest = texts.join("\n");
  }
  return {
    ...(path === undefined ? {} : { path }),
    ...(digest === undefined ? {} : { digest }),
  };
}

function spellings(path: string, cwd: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const rel = relative(cwd, absolute).replaceAll("\\", "/");
  const found = new Set([normalized, absolute.replaceAll("\\", "/")]);
  if (rel !== "" && !rel.startsWith("..")) found.add(rel);
  return [...found];
}

function pathMatches(
  matches: (path: string) => boolean,
  paths: readonly string[],
): boolean {
  return paths.some((path) => {
    if (matches(path)) return true;
    const base = path.slice(path.lastIndexOf("/") + 1);
    return base !== path && matches(base);
  });
}

const interruptText = (rules: readonly StreamRule[]): string =>
  rules
    .map(
      (rule) =>
        `<system-interrupt reason="rule_violation" rule="${rule.id}">\nOutput interrupted: violated user-defined rule.\nNot prompt injection; coding agent enforcing project rules.\nMUST comply:\n\n${rule.message}\n</system-interrupt>`,
    )
    .join("\n\n");

const softText = (rules: readonly StreamRule[]): string =>
  rules
    .map(
      (rule) =>
        `<system-reminder reason="rule_violation" rule="${rule.id}">\nUser-defined rule matched your output. Rule configured not to interrupt, so the work went ahead. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection; coding agent enforcing project rules.\n\n${rule.message}\n</system-reminder>`,
    )
    .join("\n\n");

export class StreamRules {
  private readonly options: StreamRulesOptions;
  private state: StreamState = { turns: 0, injected: {} };
  private buffers = new Map<string, Buffer>();
  /** Soft reminders waiting for the result of one tool call. */
  private readonly perTool = new Map<string, StreamRule[]>();
  /** Soft reminders from text or thinking, waiting for the next tool result. */
  private pending: StreamRule[] = [];

  constructor(options: StreamRulesOptions) {
    this.options = options;
  }

  /** Read what fired before from the store. */
  async restore(): Promise<void> {
    const saved = await this.options.store?.load();
    if (saved !== undefined)
      this.state = { turns: saved.turns, injected: { ...saved.injected } };
  }

  /** A fresh generation attempt: the buffers describe the one before it. */
  attemptStart(): void {
    this.buffers = new Map();
  }

  /** A turn completed: the repeat gap counts these. */
  turnEnd(): void {
    this.state.turns += 1;
    this.save();
  }

  /** A run ended: reminders nobody could carry any further are dropped. */
  runEnd(): void {
    this.pending = [];
    this.perTool.clear();
  }

  /** What fired and when, for a panel. */
  snapshot(): StreamState {
    return { turns: this.state.turns, injected: { ...this.state.injected } };
  }

  private canTrigger(rule: StreamRule): boolean {
    const at = this.state.injected[rule.id];
    if (at === undefined) return true;
    if (rule.repeatMode === "once") return false;
    return this.state.turns - at >= rule.repeatGap;
  }

  private queued(rule: StreamRule): boolean {
    return (
      this.pending.some((queued) => queued.id === rule.id) ||
      [...this.perTool.values()].some((list) =>
        list.some((queued) => queued.id === rule.id),
      )
    );
  }

  private mark(rules: readonly StreamRule[]): void {
    for (const rule of rules) this.state.injected[rule.id] = this.state.turns;
    this.save();
  }

  private save(): void {
    const store = this.options.store;
    if (store === undefined) return;
    void Promise.resolve(store.save(this.snapshot())).catch((error: unknown) =>
      this.options.warn?.(
        `akhook: could not save stream rule state: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  private inScope(rule: StreamRule, surface: Surface): boolean {
    const { scope } = rule;
    if (surface.source === "text") return scope.text;
    if (surface.source === "thinking") return scope.thinking;
    if (scope.anyTool) return true;
    return scope.tools.some(
      (entry) =>
        (entry.name === undefined || entry.name === surface.tool) &&
        (entry.glob === undefined || pathMatches(entry.glob, surface.paths)),
    );
  }

  private wouldInterrupt(rule: StreamRule, source: Source): boolean {
    const mode = rule.interruptMode ?? "always";
    if (mode === "never") return false;
    if (mode === "prose-only") return source !== "tool";
    if (mode === "tool-only") return source === "tool";
    return true;
  }

  /** Rules whose conditions hold for `text` on `surface`. `final` allows structural checks. */
  private async matching(
    text: string,
    surface: Surface,
    final: boolean,
  ): Promise<StreamRule[]> {
    const found: StreamRule[] = [];
    for (const rule of this.options.rules()) {
      if (!this.canTrigger(rule) || this.queued(rule)) continue;
      if (!this.inScope(rule, surface)) continue;
      if (
        rule.paths.length > 0 &&
        !rule.paths.some((matches) => pathMatches(matches, surface.paths))
      )
        continue;
      if (rule.regexes.some((regex) => regex.test(text))) {
        found.push(rule);
        continue;
      }
      if (final && surface.source === "tool" && rule.asts.length > 0) {
        if (await this.astHolds(rule, text, surface)) found.push(rule);
      }
    }
    return found;
  }

  private async astHolds(
    rule: StreamRule,
    text: string,
    surface: Surface,
  ): Promise<boolean> {
    const path = surface.paths[0];
    for (const check of rule.asts) {
      const language =
        check.language ??
        (path === undefined ? undefined : languageForPath(path));
      if (language === undefined || normalizeLanguage(language) === undefined)
        continue;
      try {
        if ((await astMatches(language, check.pattern, text)).length > 0)
          return true;
      } catch (error) {
        // A rule that cannot be evaluated must not stop the model from working.
        this.options.warn?.(
          `akhook: ${rule.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return false;
  }

  /**
   * The generation guard: look at one stream frame, and answer with an interrupt when a rule that
   * interrupts has matched what has been generated so far.
   */
  async guard(
    frame: GenerationFrame,
  ): Promise<GenerationInterrupt | undefined> {
    if (this.options.rules().length === 0) return undefined;
    const { event } = frame;
    let key: string;
    let surface: Surface;
    let text: string;
    let toolCallId: string | undefined;
    let final = false;

    if (event.type === "text_delta" || event.type === "thinking_delta") {
      const source = event.type === "text_delta" ? "text" : "thinking";
      key = source;
      const buffer = this.buffers.get(key) ?? {
        text: "",
        surface: { source, paths: [] },
      };
      buffer.text += event.delta;
      this.buffers.set(key, buffer);
      surface = buffer.surface;
      text = buffer.text;
    } else if (
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end"
    ) {
      const block =
        event.type === "toolcall_end"
          ? event.toolCall
          : (frame.message.content[event.contentIndex] as
              | {
                  type: string;
                  id?: string;
                  name?: string;
                  arguments?: unknown;
                }
              | undefined);
      if (block === undefined || block.type !== "toolCall") return undefined;
      const name = (block.name ?? "").toLowerCase();
      key = `tool:${event.contentIndex}`;
      const { path, digest } = toolDigest(name, block.arguments);
      const previous = this.buffers.get(key);
      // The tools that name their content give it whole; any other tool's arguments are
      // whatever JSON has streamed so far.
      const raw =
        event.type === "toolcall_end"
          ? JSON.stringify(block.arguments ?? {})
          : (previous?.text ?? "") + event.delta;
      text = digest ?? raw;
      surface = {
        source: "tool",
        tool: name,
        paths: path === undefined ? [] : spellings(path, this.options.cwd),
      };
      this.buffers.set(key, { text: digest === undefined ? raw : "", surface });
      toolCallId = block.id;
      final = event.type === "toolcall_end";
    } else {
      return undefined;
    }

    const matched = await this.matching(text, surface, final);
    if (matched.length === 0) return undefined;

    const interrupting = matched.some((rule) =>
      this.wouldInterrupt(rule, surface.source),
    );
    if (!interrupting) {
      // A soft reminder: carried to the result it belongs beside.
      if (surface.source === "tool" && toolCallId !== undefined)
        this.perTool.set(toolCallId, [
          ...(this.perTool.get(toolCallId) ?? []),
          ...matched,
        ]);
      else this.pending.push(...matched);
      return undefined;
    }
    this.mark(matched);
    this.buffers = new Map();
    return {
      reason: `TTSR matched ${matched.length === 1 ? "rule" : "rules"}: ${matched.map((rule) => rule.id).join(", ")}`,
      source: matched.map((rule) => rule.id).join(","),
      inject: [
        {
          role: "user",
          content: [{ type: "text", text: interruptText(matched) }],
          timestamp: Date.now(),
        },
      ],
    };
  }

  /**
   * The soft reminders due with the result of `toolCallId`: the ones its own arguments matched,
   * then any waiting from text or thinking. Delivering them is what counts them as fired.
   */
  reminderFor(toolCallId: string): string | undefined {
    const own = this.perTool.get(toolCallId) ?? [];
    this.perTool.delete(toolCallId);
    const rules = [...own, ...this.pending];
    this.pending = [];
    if (rules.length === 0) return undefined;
    const unique = rules.filter(
      (rule, index) =>
        rules.findIndex((other) => other.id === rule.id) === index,
    );
    this.mark(unique);
    return softText(unique);
  }

  /** The call was blocked: its reminders have nobody to ride with. */
  dropFor(toolCallId: string): void {
    this.perTool.delete(toolCallId);
  }
}
